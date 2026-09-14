import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { safeDecryptToken, encryptToken } from "../_shared/encryption.ts";
import { isOutOfOfficeReply, detectDeferSignal } from "../_shared/oooDetection.ts";
import { applyOOOPause, applyDeferPause } from "../_shared/oooPauseActions.ts";
import {
  hasSubstantiveQuestion,
  SUBSTANTIVE_QUESTION_FLAG,
} from "../_shared/inboundIntentDetectors.ts";
import { detectMeetingConfirmation } from "../_shared/meetingConfirmation.ts";
import { isHumanUnsubscribeRequest } from "../_shared/unsubscribeDetection.ts";
import { createCanonicalInteraction } from "../_shared/canonicalInteraction.ts";
import { emailDedupeKey } from "../_shared/timelineProjector.ts";
import { detectBounce } from "../_shared/bounceDetection.ts";
import { bounceDisposition } from "../_shared/bounceDisposition.ts";
import { isDirectConversation } from "../_shared/directConversation.ts";
import { gmailDirectDiscoveryQuery, selectThreadsToExpand } from "../_shared/gmailDiscovery.ts";
import { extractEmailsFromHeader } from "../_shared/emailUtils.ts";
import { isInternalCaller, isServiceRoleToken } from "../_shared/authz.ts";
import { deriveAction } from "../_shared/bulkSyncAction.ts";
import { mustClearEligibleAt, RATE_LIMITED_KEY } from "../_shared/followupRule.ts";
import { deepMergeCadence, DEFAULT_CADENCE_SETTINGS } from "../_shared/syncEngine.ts";

/** Per-strategy mode settings for one owner's workspace profile. */
type CadenceModes = { fast?: { followup_wait_days?: number }; nurture?: { followup_wait_days?: number } };

/**
 * Load the owner's merged cadence modes ONCE per connection / request (not per
 * lead), so the scheduled path honours
 * `cadence_settings.modes.*.followup_wait_days` like every other path. Cost: one
 * extra read per Gmail connection per sweep. Null on any failure — the rule then
 * falls back to its 3/5 defaults rather than skipping leads.
 */
// deno-lint-ignore no-explicit-any
async function loadCadenceModes(serviceSupabase: any, userId: string | null | undefined): Promise<CadenceModes | null> {
  if (!userId) return null;
  const { data } = await serviceSupabase
    .from("workspace_profiles")
    .select("cadence_settings")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;
  return deepMergeCadence(DEFAULT_CADENCE_SETTINGS, data.cadence_settings ?? {}).modes as CadenceModes;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{ mimeType: string; body?: { data?: string } }>;
  };
  internalDate: string;
}

interface LeadMetrics {
  first_outbound_at: string | null;
  last_outbound_at: string | null;
  last_inbound_at: string | null;
  meeting_summary_count: number;
  nurture_outbound_count: number;
  last_nurture_outbound_at: string | null;
}

// Resolved Gmail mailbox — either the canonical workspace-scoped mail_accounts row
// or the legacy per-user gmail_connections row. Mirrors gmail-sync's resolution so
// a multi-workspace / multi-mailbox user syncs the ACTIVE workspace's mailbox. The
// scheduled path passes a raw gmail_connections row (no `source`), which falls to
// the gmail_connections branch in refreshTokenIfNeeded.
interface GmailTokenConnection {
  source?: "mail_accounts" | "gmail_connections";
  id?: string;
  user_id: string;
  gmail_email?: string | null;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string | null;
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return decodeURIComponent(escape(atob(base64)));
  } catch {
    return atob(base64);
  }
}

function getHeader(headers: Array<{ name: string; value: string }>, name: string): string | undefined {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;
}

// Extract email addresses from a header value (handles "Name" <email> format and comma-separated lists)
function extractEmailAddresses(headerValue: string): string[] {
  const emails: string[] = [];
  // Match email patterns: either <email@domain.com> or standalone email@domain.com
  const emailRegex = /<([^>]+@[^>]+)>|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  let match;
  while ((match = emailRegex.exec(headerValue)) !== null) {
    const email = (match[1] || match[2]).toLowerCase().trim();
    if (email) {
      emails.push(email);
    }
  }
  return emails;
}

function messageInvolvesLead(headers: Array<{ name: string; value: string }>, leadEmail: string): boolean {
  const needle = leadEmail.trim().toLowerCase();
  if (!needle) return false;

  // Extract all email addresses from relevant headers
  const from = getHeader(headers, "From") || "";
  const to = getHeader(headers, "To") || "";
  const cc = getHeader(headers, "Cc") || "";
  const bcc = getHeader(headers, "Bcc") || "";
  
  const allEmails = [
    ...extractEmailAddresses(from),
    ...extractEmailAddresses(to),
    ...extractEmailAddresses(cc),
    ...extractEmailAddresses(bcc),
  ];

  // Perform exact email match, not substring match
  return allEmails.some(email => email === needle);
}

function getMessageBody(message: GmailMessage): string {
  if (message.payload.body?.data) {
    return decodeBase64Url(message.payload.body.data);
  }
  
  if (message.payload.parts) {
    const textPart = message.payload.parts.find(p => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      return decodeBase64Url(textPart.body.data);
    }
    const htmlPart = message.payload.parts.find(p => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      const html = decodeBase64Url(htmlPart.body.data);
      return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    }
  }
  
  return message.snippet || "";
}

/**
 * Concatenate every `message/delivery-status` part of a DSN.
 *
 * A standards-shaped multipart/report bounce names the failed address and its
 * RFC 3463 status code ONLY in this machine part — `getMessageBody` returns
 * the human text/plain part, which often carries neither. Without it a real
 * 5.x.x hard bounce classifies as "unclassifiable" → soft → never suppressed.
 *
 * ponytail: byte-identical to gmail-sync's private copy. It stays duplicated
 * because gmail-sync is owned by another unit right now; the upgrade path is
 * one `_shared/gmailPayload.ts` when both files are in the same hand.
 */
// deno-lint-ignore no-explicit-any
function getDeliveryStatusText(message: any): string {
  const out: string[] = [];
  // deno-lint-ignore no-explicit-any
  const walk = (part: any) => {
    const mime = (part.mimeType || "").toLowerCase();
    if (part.body?.data && mime.includes("delivery-status")) {
      out.push(decodeBase64Url(part.body.data));
    }
    if (part.parts) for (const p of part.parts) walk(p);
  };
  if (message?.payload?.parts) for (const p of message.payload.parts) walk(p);
  return out.join("\n\n");
}

/**
 * Permanently stop a lead after a HARD bounce, and record why.
 *
 * Only ever called when `classifyBounce` returned "hard". A soft/transient
 * bounce (mailbox full, greylisting, an out-of-office autoresponder that looks
 * DSN-ish) must never reach this — it used to, and it permanently opted real
 * customers out of all future contact.
 */
// deno-lint-ignore no-explicit-any
async function applyHardBounceStop(
  serviceSupabase: any,
  leadId: string,
  workspaceId: string | null,
  subject: string,
): Promise<void> {
  await serviceSupabase.from("leads").update({
    unsubscribed: true,
    needs_action: false,
    eligible_at: null,
    next_action_key: null,
    next_action_label: null,
    action_reason_code: null,
    nurture_status: "inactive",
  }).eq("id", leadId);

  await createCanonicalInteraction(serviceSupabase, {
    lead_id: leadId,
    type: "system_note",
    source: "automation",
    body_text: `Email bounced/undeliverable (subject: "${subject}") — automation stopped permanently. Please verify the email address.`,
    occurred_at: new Date().toISOString(),
    workspace_id: workspaceId,
    provider: "automation",
  });
}

// deno-lint-ignore no-explicit-any
async function refreshTokenIfNeeded(
  supabase: any,
  connection: GmailTokenConnection
): Promise<string> {
  const expiresAt = new Date(connection.token_expires_at ?? 0);
  const now = new Date();
  
  // Decrypt the stored tokens (use encrypted columns)
  const decryptedAccessToken = await safeDecryptToken(connection.access_token_encrypted ?? "");
  const decryptedRefreshToken = await safeDecryptToken(connection.refresh_token_encrypted ?? "");
  
  if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
    console.log("[gmail-bulk-sync] Refreshing expired token");
    
    const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
    
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      console.error("[gmail-bulk-sync] Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET");
      throw new Error("Missing Google OAuth credentials");
    }

    if (!decryptedRefreshToken) {
      console.error("[gmail-bulk-sync] No refresh token available - user needs to reconnect Gmail");
      throw new Error("No refresh token - please reconnect Gmail");
    }

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: decryptedRefreshToken,
        grant_type: "refresh_token",
      }),
    });
    
    if (!response.ok) {
      const errorBody = await response.text();
      console.error("[gmail-bulk-sync] Token refresh failed:", response.status, errorBody);
      
      // Check for specific Google errors
      if (errorBody.includes("invalid_grant")) {
        throw new Error("Gmail access revoked - please reconnect Gmail in Settings");
      }
      throw new Error(`Failed to refresh token: ${response.status}`);
    }
    
    const tokens = await response.json();
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    
    // Fail closed: a missing TOKEN_ENCRYPTION_KEY or crypto error fails the
    // sync rather than persisting a plaintext token.
    const encryptedNewAccessToken = await encryptToken(tokens.access_token);

    if (connection.source === "mail_accounts" && connection.id) {
      await supabase
        .from("mail_accounts")
        .update({
          access_token: encryptedNewAccessToken,
          token_expires_at: newExpiresAt,
          needs_reconnect: false,
          status: "connected",
          error_reason: null,
        })
        .eq("id", connection.id);
    } else {
      await supabase
        .from("gmail_connections")
        .update({
          access_token_encrypted: encryptedNewAccessToken,
          token_expires_at: newExpiresAt,
        })
        .eq("user_id", connection.user_id);
    }

    return tokens.access_token;
  }

  return decryptedAccessToken;
}

// Resolve the connected Gmail mailbox for a workspace: prefer the canonical
// workspace-scoped mail_accounts row (provider='gmail', connected, prefer
// is_default), fall back to the legacy per-user gmail_connections row. Mirrors
// per-lead gmail-sync. A null workspaceId (legacy lead) skips straight to the
// per-user fallback. Returns null when neither mailbox exists.
// deno-lint-ignore no-explicit-any
async function resolveGmailConnection(
  serviceSupabase: any,
  workspaceId: string | null,
  userId: string,
): Promise<GmailTokenConnection | null> {
  if (workspaceId) {
    const { data: account } = await serviceSupabase
      .from("mail_accounts")
      .select("id, user_id, email_address, access_token, refresh_token, token_expires_at")
      .eq("workspace_id", workspaceId)
      .eq("provider", "gmail")
      .eq("status", "connected")
      .order("is_default", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (account?.access_token && account?.refresh_token) {
      return {
        source: "mail_accounts",
        id: account.id,
        user_id: account.user_id ?? userId,
        gmail_email: account.email_address,
        access_token_encrypted: account.access_token,
        refresh_token_encrypted: account.refresh_token,
        token_expires_at: account.token_expires_at,
      };
    }
  }

  const { data: legacyConnection } = await serviceSupabase
    .from("gmail_connections")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (legacyConnection) {
    return {
      source: "gmail_connections",
      user_id: legacyConnection.user_id,
      gmail_email: legacyConnection.gmail_email,
      access_token_encrypted: legacyConnection.access_token_encrypted,
      refresh_token_encrypted: legacyConnection.refresh_token_encrypted,
      token_expires_at: legacyConnection.token_expires_at,
    };
  }
  return null;
}

function containsClosingKeywords(text: string): boolean {
  const keywords = ["pricing", "contract", "procurement", "security review", "legal", "proposal", "quote", "budget"];
  const lowerText = text.toLowerCase();
  return keywords.some(kw => lowerText.includes(kw));
}

function deriveStage(
  currentStage: string,
  metrics: LeadMetrics,
  hasClosingKeywords: boolean
): string {
  if (currentStage === "closed_won" || currentStage === "closed_lost") {
    return currentStage;
  }

  if (hasClosingKeywords && metrics.last_inbound_at) {
    return "closing";
  }

  if (metrics.meeting_summary_count > 0) {
    return "post_meeting";
  }

  if (metrics.last_inbound_at && metrics.first_outbound_at) {
    const inboundTime = new Date(metrics.last_inbound_at).getTime();
    const firstOutTime = new Date(metrics.first_outbound_at).getTime();
    if (inboundTime > firstOutTime) {
      return "engaged";
    }
  }

  if (metrics.first_outbound_at) {
    return "contacted";
  }

  return "new";
}

// deno-lint-ignore no-explicit-any
async function syncLeadEmails(
  serviceSupabase: any,
  accessToken: string,
  lead: { id: string; email: string; stage: string; strategy: string; workspace_id?: string | null },
  maxResults: number,
  cadenceModes: CadenceModes | null = null,
  // The mailbox we are syncing FROM. Required by the rep↔lead gate below; when
  // it is unknown the gate fails closed and nothing is stored (see the gate).
  repEmail = "",
): Promise<{ synced: number; errors: string[]; stage: string }> {
  const { id: leadId, email: leadEmail, stage: currentStage } = lead;
  const workspaceId = lead.workspace_id ?? null;
  // Lower-cased: every address comparison below (the gate, the DSN attribution,
  // the direction test) is case-insensitive, and RFC 5321 local parts arrive in
  // whatever case the sender typed.
  const leadEmailNorm = typeof leadEmail === "string" ? leadEmail.trim().toLowerCase() : "";
  const repEmailNorm = repEmail.trim().toLowerCase();
  if (!repEmailNorm) {
    console.warn(
      `[gmail-bulk-sync] Lead ${leadId}: no rep mailbox address available — the direct-conversation gate will drop every message. Reconnect Gmail to repopulate gmail_connections.gmail_email.`,
    );
  }
  const errors: string[] = [];
  let synced = 0;
  let hasClosingKeywords = false;

  if (!leadEmailNorm) {
    return { synced: 0, errors: ["Lead email is missing"], stage: currentStage };
  }

  // Get existing thread IDs locked to this lead
  const { data: existingThreads } = await serviceSupabase
    .from("interactions")
    .select("gmail_thread_id")
    .eq("lead_id", leadId)
    .not("gmail_thread_id", "is", null);

  const lockedThreadIds = new Set<string>(
    (existingThreads || []).map((i: { gmail_thread_id: string }) => i.gmail_thread_id).filter(Boolean)
  );

  // Discover the lead's conversation threads across more history than one page.
  // messages.list returns {id, threadId} cheaply; we seed thread expansion
  // (below) with EVERY discovered thread so old outbound-only threads (e.g. a
  // cold sequence that never got a reply) get backfilled — not just the newest
  // page. The per-message loop still directly processes only the newest
  // `maxResults`; the (one-fetch-per-thread) expansion fills in the rest.
  // ponytail: DISCOVERY_MAX / MAX_THREADS_PER_LEAD cap backfill depth per run;
  // deeper history for very large mailboxes is a future work-queue/drain job.
  const DISCOVERY_MAX = 200;
  // 25 covers virtually every real B2B lead's conversation count while bounding
  // per-run work (Refresh syncs 15 leads/batch sequentially; 15 × 25 thread
  // fetches stays well under the function time limit). If timeouts ever appear on
  // deep-history accounts, the next lever is a smaller Refresh batch (frontend
  // useMailSync.syncLeads) and ultimately the work-queue/drain job.
  const MAX_THREADS_PER_LEAD = 25;
  // Backfilled OLD inbound must NOT re-fire guardrails — a months-old OOO /
  // bounce / unsubscribe surfacing now would wrongly pause or permanently stop a
  // currently-active lead. The thread-expansion loop only runs the inbound
  // action branches for messages newer than this; the newest-page per-message
  // loop below still handles every genuinely-live signal.
  const BACKFILL_RECENCY_MS = 3 * 24 * 60 * 60 * 1000;

  // DIRECT rep↔lead discovery only (Unit G-B P1). `from:X OR to:X` admitted
  // third-party threads that the direct-conversation gate then rejected without
  // leaving a trace — so they looked "never synced", sorted to the front of the
  // expansion queue, and with more than MAX_THREADS_PER_LEAD of them a genuine
  // older reply was never expanded while the automation kept emailing. The
  // gate's predicate is now the query itself; see `_shared/gmailDiscovery.ts`.
  const query = gmailDirectDiscoveryQuery(leadEmailNorm, repEmailNorm);
  const searchUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${DISCOVERY_MAX}`;

  const searchResponse = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!searchResponse.ok) {
    const errorText = await searchResponse.text();
    console.error(`[gmail-bulk-sync] Search failed for ${leadEmail}:`, errorText);

    // If the token is missing required Gmail scopes (common after an app permissions change),
    // force the UI down the reauthorization path.
    const scopeInsufficient =
      errorText.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") ||
      errorText.includes("insufficientPermissions") ||
      errorText.includes("insufficient authentication scopes") ||
      errorText.includes("PERMISSION_DENIED");
    if (scopeInsufficient) {
      throw new Error("Gmail permissions need updating - please reauthorize Gmail in Settings");
    }

    return { synced: 0, errors: [`Gmail search failed for ${leadEmail}`], stage: currentStage };
  }

  const searchData = await searchResponse.json();
  const discovered = searchData.messages || [];
  // Remember which threads were ALREADY synced before this run, so the bounded
  // expansion below can prioritise never-synced (backfill) threads over re-
  // fetching known ones — otherwise a lead with ≥MAX_THREADS_PER_LEAD existing
  // threads would spend every slot re-checking known threads and never backfill.
  const previouslySyncedThreadIds = new Set(lockedThreadIds);
  // Seed thread expansion with every discovered thread — this is the backfill.
  for (const m of discovered) {
    if (m.threadId) lockedThreadIds.add(m.threadId);
  }
  // Direct per-message processing stays bounded to the newest page (unchanged).
  const messageIds = discovered.slice(0, maxResults);

  console.log(`[gmail-bulk-sync] Discovered ${discovered.length} messages / ${lockedThreadIds.size} threads for ${leadEmailNorm}; processing newest ${messageIds.length} directly`);

  // Get existing Gmail message IDs for deduplication
  const { data: existingInteractions } = await serviceSupabase
    .from("interactions")
    .select("gmail_message_id, body_text")
    .eq("lead_id", leadId)
    .not("gmail_message_id", "is", null);

  const existingMessageIds = new Set(
    (existingInteractions || []).map((i: { gmail_message_id: string }) => i.gmail_message_id)
  );
  const existingBodyByMessageId = new Map(
    (existingInteractions || []).map((i: { gmail_message_id: string; body_text: string | null }) => [i.gmail_message_id, i.body_text])
  );

  // Fetch and process each message
  for (const { id: gmailMessageId } of messageIds) {
    const existingBody = existingBodyByMessageId.get(gmailMessageId);
    const shouldRestorePurgedBody = existingMessageIds.has(gmailMessageId) && (!existingBody || existingBody.trim() === "");
    if (existingMessageIds.has(gmailMessageId) && !shouldRestorePurgedBody) {
      continue;
    }

    try {
      const msgResponse = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailMessageId}?format=full`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (!msgResponse.ok) continue;

      const message: GmailMessage = await msgResponse.json();
      const headers = message.payload.headers;
      const threadId = message.threadId;
      
      // Skip draft messages — only sync sent and received emails
      if (message.labelIds?.includes("DRAFT")) {
        console.log(`[gmail-bulk-sync] Skipping draft message ${gmailMessageId}`);
        continue;
      }
      
      lockedThreadIds.add(threadId);

      const from = getHeader(headers, "From") || "";
      const to = getHeader(headers, "To") || "";
      const cc = getHeader(headers, "Cc") || "";
      const toEmailsArr = extractEmailsFromHeader(to);
      const ccEmailsArr = extractEmailsFromHeader(cc);
      const subject = getHeader(headers, "Subject") || "(no subject)";
      const date = getHeader(headers, "Date");
      const occurredAt = date ? new Date(date).toISOString() : new Date(parseInt(message.internalDate)).toISOString();

      // A DSN comes FROM postmaster/mailer-daemon and names the lead only in
      // its body, so it fails both gates below. Detect it first and let it
      // through — the bounce block does its own attribution.
      const bounce = detectBounce(from, subject);

      if (!messageInvolvesLead(headers, leadEmailNorm) && !bounce.isBounce) {
        console.warn(
          `[gmail-bulk-sync] Skipping message ${gmailMessageId} (does not involve lead email ${leadEmailNorm})`
        );
        continue;
      }

      // DIRECT-CONVERSATION GATE (Unit G-B P1).
      //
      // `messageInvolvesLead` only asks "is this address anywhere in the
      // headers?" — true for a newsletter the lead is subscribed to, a vendor
      // thread they are Cc'd on, or any third-party mail that happens to name
      // them. bulk-sync had nothing stronger, so all of that was stored on the
      // lead's timeline and counted in its inbound/outbound metrics. gmail-sync
      // and outlook-sync have always required a direct rep↔lead exchange; this
      // is the same rule, from the same shared function.
      //
      // Computed for EVERY message, including DSN-looking ones, because
      // `bounceDisposition` needs it: passing this gate proves the message is
      // human conversation and therefore not a machine bounce, however DSN-ish
      // its subject reads. The skip itself is applied further down, only to
      // messages the bounce path did not claim.
      const isDirect = isDirectConversation({
        fromEmails: extractEmailAddresses(from),
        recipientEmails: toEmailsArr,
        leadEmail: leadEmailNorm,
        repEmail: repEmailNorm,
      });

      // Exact-address direction test. A substring test ("does From contain the
      // lead's address") called "joann@acme.com" a message from "ann@acme.com".
      const isFromLead = extractEmailAddresses(from).includes(leadEmailNorm);
      const direction = isFromLead ? "inbound" : "outbound";
      const type = isFromLead ? "email_inbound" : "email_outbound";

      const bodyText = getMessageBody(message);

      if (direction === "inbound" && containsClosingKeywords(bodyText + " " + subject)) {
        hasClosingKeywords = true;
      }

      // BOUNCE HANDLING (Unit G-B P1). Two defects fixed here:
      //   1. ANY DSN-ish keyword used to set `unsubscribed = true`. A SOFT
      //      bounce — mailbox full, greylisting, a temporary defer — therefore
      //      opted a real, reachable customer out of all future contact,
      //      permanently. `classifyBounce` decides; only a clear 5.x.x /
      //      permanent-failure signal suppresses, and anything unclassifiable
      //      falls back to soft (never burn a good lead).
      //   2. The DSN then FELL THROUGH to the normal insert. It is from
      //      postmaster, so `isFromLead` is false and it was stored as
      //      `email_outbound` — a fake "sent email" that corrupted
      //      last_outbound_at and every outbound counter. Both branches now
      //      `continue`.
      const verdict = bounce.isBounce
        ? bounceDisposition({
          fromEmail: from,
          subject,
          bodyText,
          deliveryStatusText: getDeliveryStatusText(message),
          leadEmail: leadEmailNorm,
          headersInvolveLead: messageInvolvesLead(headers, leadEmailNorm),
          isDirectConversation: isDirect,
        })
        : { disposition: "not_a_bounce" as const, statusCode: null, basis: null };

      if (verdict.disposition !== "not_a_bounce") {
        // Only a MACHINE DSN reaches here — `bounceDisposition` returns
        // "not_a_bounce" for anything that passed the rep↔lead gate or came
        // from the lead's own mailbox, so no human message is dropped by these
        // branches. A machine DSN fails the gate anyway, so skipping it here
        // stores nothing that the gate below would have stored.
        if (verdict.disposition === "not_about_lead") {
          console.log(`[gmail-bulk-sync] Bounce ${gmailMessageId} is not about lead ${leadEmailNorm} — skipping`);
          continue;
        }
        if (verdict.disposition === "transient") {
          console.log(
            `[gmail-bulk-sync] Lead ${leadId}: transient bounce (code: ${verdict.statusCode ?? "none"}, basis: ${verdict.basis}) — leaving cadence to retry`,
          );
          existingMessageIds.add(gmailMessageId);
          continue;
        }

        console.log(`[gmail-bulk-sync] Lead ${leadId}: Hard bounce (code: ${verdict.statusCode ?? "keyword/none"}, subject: "${subject}") — stopping automation`);
        await applyHardBounceStop(serviceSupabase, leadId, workspaceId, subject);
        existingMessageIds.add(gmailMessageId);
        continue;
      }

      // Not a bounce (or a human message wearing DSN wording). Now apply the
      // direct-conversation skip.
      if (!isDirect) {
        console.log(
          `[gmail-bulk-sync] Skipping 3rd-party message ${gmailMessageId} (not direct rep↔lead email, from: "${from}", to: "${to}")`
        );
        continue;
      }
      // Set when applyOOOPause paused the lead but deliberately KEPT it
      // actionable (auto-reply carrying a live commercial question). The
      // defer branch below must not then clear needs_action again.
      let oooKeptActionable = false;
      // OOO / Auto-reply detection — must run BEFORE counting as real inbound
      if (direction === "inbound") {
        const oooResult = isOutOfOfficeReply(headers, subject, bodyText);
        const oooPause = await applyOOOPause({
          supabase: serviceSupabase,
          leadId,
          workspaceId,
          oooResult,
          occurredAt,
          gmailMessageId,
          gmailThreadId: threadId,
          logPrefix: "[gmail-bulk-sync]",
        });
        // Branch on `.skipInbound`, never on the object — see gmail-sync.
        if (oooPause.skipInbound) {
          existingMessageIds.add(gmailMessageId);
          synced++;
          continue;
        }
        oooKeptActionable = oooPause.paused;
      }

      // ── Defer / "reconnect later" detection ──
      // Skipped when the OOO deliberately kept this lead actionable.
      if (direction === "inbound" && !oooKeptActionable) {
        const deferResult = detectDeferSignal(bodyText, new Date(occurredAt));
        await applyDeferPause({
          supabase: serviceSupabase,
          leadId,
          workspaceId,
          deferResult,
          logPrefix: "[gmail-bulk-sync]",
        });
      }

      // ── Meeting confirmation detection ──
      if (direction === "inbound") {
        const meetingResult = detectMeetingConfirmation(subject, bodyText);
        if (meetingResult.isConfirmed) {
          // Body-aware override (EDGE_CASES #4): see gmail-sync for rationale.
          const override = meetingResult.hasSubstantiveQuestion;
          const leadUpdate: Record<string, unknown> = { has_future_meeting: true };
          if (!override) leadUpdate.needs_action = false;

          console.log(
            `[gmail-bulk-sync] Lead ${leadId}: Meeting confirmed (${meetingResult.confidence}): "${meetingResult.matchedText}"`
            + (override ? ` — keeping action open, matched: ${meetingResult.matchedKeywords.join(", ")}` : ""),
          );
          await serviceSupabase.from("leads").update(leadUpdate).eq("id", leadId);

          const noteBody = override
            ? `📅 Meeting confirmed — "${meetingResult.matchedText}". Reply still needed — substantive question detected (matched: ${meetingResult.matchedKeywords.join(", ")}).`
            : `📅 Meeting confirmed — "${meetingResult.matchedText}". No reply needed.`;
          await createCanonicalInteraction(serviceSupabase, {
            lead_id: leadId,
            type: "system_note",
            source: "automation",
            body_text: noteBody,
            occurred_at: new Date().toISOString(),
            workspace_id: workspaceId,
            provider: "automation",
          });
        }
      }

      const canonResult = await createCanonicalInteraction(serviceSupabase, {
        lead_id: leadId,
        type,
        source: "gmail",
        body_text: bodyText.substring(0, 10000),
        occurred_at: occurredAt,
        direction,
        subject,
        from_email: from,
        to_email: to,
        to_emails: toEmailsArr,
        cc_emails: ccEmailsArr,
        gmail_message_id: gmailMessageId,
        gmail_thread_id: threadId,
        workspace_id: workspaceId,
        provider: "gmail",
        // Decided against the FULL body; classify-inbound only sees the
        // 500-char snippet (Codex P1, PR #143).
        metadata_json: direction === "inbound"
          ? { [SUBSTANTIVE_QUESTION_FLAG]: hasSubstantiveQuestion(bodyText) }
          : {},
        dedupe_key: emailDedupeKey("gmail", gmailMessageId, gmailMessageId),
      });

      if (canonResult.error && canonResult.error !== "duplicate") {
        errors.push(`Failed to insert message ${gmailMessageId}: ${canonResult.error}`);
      } else if (!canonResult.error) {
        synced++;
        existingMessageIds.add(gmailMessageId);
      }
    } catch (err) {
      errors.push(`Error processing message ${gmailMessageId}: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  }

  // Fetch messages from locked threads, bounded per run. Prioritise never-synced
  // (backfill) threads over already-synced ones — recent activity in known
  // threads is already covered by the newest-page per-message loop above, so the
  // scarce slots are best spent pulling threads we've never seen.
  const threadsToExpand = selectThreadsToExpand(lockedThreadIds, previouslySyncedThreadIds, MAX_THREADS_PER_LEAD);
  for (const threadId of threadsToExpand) {
    try {
      const threadUrl = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`;
      const threadResponse = await fetch(threadUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!threadResponse.ok) continue;

      const threadData = await threadResponse.json();
      const threadMessages = threadData.messages || [];

      for (const message of threadMessages) {
        const gmailMessageId = message.id;
        // Skip drafts — only sync sent and received emails (mirrors the
        // per-message loop). Discovery seeds thread IDs from list stubs that
        // carry no labels, so an unsent draft sharing a thread must be filtered
        // here or it would be stored as a fake sent email.
        if (message.labelIds?.includes("DRAFT")) continue;
        const existingBody = existingBodyByMessageId.get(gmailMessageId);
        const shouldRestorePurgedBody = existingMessageIds.has(gmailMessageId) && (!existingBody || existingBody.trim() === "");
        if (existingMessageIds.has(gmailMessageId) && !shouldRestorePurgedBody) continue;

        const headers = message.payload?.headers || [];

        const from = getHeader(headers, "From") || "";
        const to = getHeader(headers, "To") || "";
        const cc = getHeader(headers, "Cc") || "";
        const toEmailsArr = extractEmailsFromHeader(to);
        const ccEmailsArr = extractEmailsFromHeader(cc);
        const subject = getHeader(headers, "Subject") || "(no subject)";
        const date = getHeader(headers, "Date");
        const occurredAt = date ? new Date(date).toISOString() : new Date(parseInt(message.internalDate)).toISOString();
        // Backfill safety: messages older than the recency window are stored as
        // history but must not drive the destructive guardrails (see constant).
        const isStaleForActions = (Date.now() - new Date(occurredAt).getTime()) > BACKFILL_RECENCY_MS;

        const bounceT = detectBounce(from, subject);

        if (!messageInvolvesLead(headers, leadEmailNorm) && !bounceT.isBounce) {
          console.warn(
            `[gmail-bulk-sync] Skipping thread message ${gmailMessageId} in thread ${threadId} (does not involve lead email ${leadEmailNorm})`
          );
          continue;
        }

        // Same direct-conversation gate as the per-message loop above. Thread
        // expansion pulls EVERY message in a locked thread, so without it a
        // third party joining the thread had their mail stored on the lead.
        // Computed for every message (see the per-message loop for why the
        // bounce decision needs it); the skip is applied after the bounce path.
        const isDirectT = isDirectConversation({
          fromEmails: extractEmailAddresses(from),
          recipientEmails: toEmailsArr,
          leadEmail: leadEmailNorm,
          repEmail: repEmailNorm,
        });

        const isFromLead = extractEmailAddresses(from).includes(leadEmailNorm);
        const direction = isFromLead ? "inbound" : "outbound";
        const type = isFromLead ? "email_inbound" : "email_outbound";

        const bodyText = getMessageBody(message);

        if (direction === "inbound" && containsClosingKeywords(bodyText + " " + subject)) {
          hasClosingKeywords = true;
        }

        // Bounce handling — same two fixes as the per-message loop: classify
        // soft vs hard before suppressing anyone, and never fall through to
        // store a DSN as a fake outbound email.
        const verdictT = bounceT.isBounce
          ? bounceDisposition({
            fromEmail: from,
            subject,
            bodyText,
            deliveryStatusText: getDeliveryStatusText(message),
            leadEmail: leadEmailNorm,
            headersInvolveLead: messageInvolvesLead(headers, leadEmailNorm),
            isDirectConversation: isDirectT,
          })
          : { disposition: "not_a_bounce" as const, statusCode: null, basis: null };

        if (verdictT.disposition !== "not_a_bounce") {
          // A stale (old) bounce must not fire the destructive unsubscribe/stop.
          if (isStaleForActions) {
            existingMessageIds.add(gmailMessageId);
            continue;
          }

          if (verdictT.disposition === "not_about_lead") {
            console.log(`[gmail-bulk-sync] Thread bounce ${gmailMessageId} is not about lead ${leadEmailNorm} — skipping`);
            continue;
          }
          if (verdictT.disposition === "transient") {
            console.log(
              `[gmail-bulk-sync] Lead ${leadId}: transient bounce in thread (code: ${verdictT.statusCode ?? "none"}, basis: ${verdictT.basis}) — leaving cadence to retry`,
            );
            existingMessageIds.add(gmailMessageId);
            continue;
          }

          console.log(`[gmail-bulk-sync] Lead ${leadId}: Hard bounce in thread (code: ${verdictT.statusCode ?? "keyword/none"}, subject: "${subject}") — stopping automation`);
          await applyHardBounceStop(serviceSupabase, leadId, workspaceId, subject);
          existingMessageIds.add(gmailMessageId);
          continue;
        }

        // Not a bounce (or a human message wearing DSN wording). Now apply the
        // direct-conversation skip.
        if (!isDirectT) {
          console.log(
            `[gmail-bulk-sync] Skipping 3rd-party thread message ${gmailMessageId} (not direct rep↔lead email, from: "${from}", to: "${to}")`
          );
          continue;
        }

        // Set when applyOOOPause paused the lead but deliberately KEPT it
        // actionable (auto-reply carrying a live commercial question). The
        // defer branch below must not then clear needs_action again.
        let oooKeptActionableT = false;
        // OOO detection in thread messages
        if (direction === "inbound" && !isStaleForActions) {
          const oooResultT = isOutOfOfficeReply(headers, subject, bodyText);
          const oooPauseT = await applyOOOPause({
            supabase: serviceSupabase,
            leadId,
            workspaceId,
            oooResult: oooResultT,
            occurredAt,
            gmailMessageId,
            gmailThreadId: threadId,
            logPrefix: "[gmail-bulk-sync:thread]",
          });
          // Branch on `.skipInbound`, never on the object — see gmail-sync.
          if (oooPauseT.skipInbound) {
            existingMessageIds.add(gmailMessageId);
            synced++;
            continue;
          }
          oooKeptActionableT = oooPauseT.paused;
        }

        // ── Defer detection in thread messages ──
        // Skipped when the OOO deliberately kept this lead actionable.
        if (direction === "inbound" && !isStaleForActions && !oooKeptActionableT) {
          const deferResult = detectDeferSignal(bodyText, new Date(occurredAt));
          await applyDeferPause({
            supabase: serviceSupabase,
            leadId,
            workspaceId,
            deferResult,
            logPrefix: "[gmail-bulk-sync:thread]",
          });
        }

        // ── Meeting confirmation detection (thread messages) ──
        if (direction === "inbound" && !isStaleForActions) {
          const meetingResult = detectMeetingConfirmation(subject, bodyText);
          if (meetingResult.isConfirmed) {
            // Body-aware override (EDGE_CASES #4): see gmail-sync for rationale.
            const override = meetingResult.hasSubstantiveQuestion;
            const leadUpdate: Record<string, unknown> = { has_future_meeting: true };
            if (!override) leadUpdate.needs_action = false;

            console.log(
              `[gmail-bulk-sync] Lead ${leadId}: Meeting confirmed in thread (${meetingResult.confidence}): "${meetingResult.matchedText}"`
              + (override ? ` — keeping action open, matched: ${meetingResult.matchedKeywords.join(", ")}` : ""),
            );
            await serviceSupabase.from("leads").update(leadUpdate).eq("id", leadId);

            const noteBody = override
              ? `📅 Meeting confirmed — "${meetingResult.matchedText}". Reply still needed — substantive question detected (matched: ${meetingResult.matchedKeywords.join(", ")}).`
              : `📅 Meeting confirmed — "${meetingResult.matchedText}". No reply needed.`;
            await createCanonicalInteraction(serviceSupabase, {
              lead_id: leadId, type: "system_note", source: "automation",
              body_text: noteBody,
              occurred_at: new Date().toISOString(), workspace_id: workspaceId, provider: "automation",
            });
          }
        }

        const threadCanon = await createCanonicalInteraction(serviceSupabase, {
          lead_id: leadId, type, source: "gmail",
          body_text: bodyText.substring(0, 10000), occurred_at: occurredAt, direction,
          subject, from_email: from, to_email: to,
          to_emails: toEmailsArr, cc_emails: ccEmailsArr,
          gmail_message_id: gmailMessageId, gmail_thread_id: threadId,
          workspace_id: workspaceId,
          provider: "gmail",
          // Decided against the FULL body — see above.
          metadata_json: direction === "inbound"
            ? { [SUBSTANTIVE_QUESTION_FLAG]: hasSubstantiveQuestion(bodyText) }
            : {},
          dedupe_key: emailDedupeKey("gmail", gmailMessageId, gmailMessageId),
        });

        if (!threadCanon.error) {
          synced++;
          existingMessageIds.add(gmailMessageId);
        }
      }
    } catch (err) {
      console.error(`[gmail-bulk-sync] Error fetching thread ${threadId}:`, err);
    }
  }

  // Compute metrics from all interactions
  const { data: allInteractions } = await serviceSupabase
    .from("interactions")
    .select("type, occurred_at, direction")
    .eq("lead_id", leadId)
    .order("occurred_at", { ascending: true });

  // Meeting count is derived from meeting_packs (source of truth)
  const { count: meetingCount } = await serviceSupabase
    .from("meeting_packs")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId);

  const metrics: LeadMetrics = {
    first_outbound_at: null,
    last_outbound_at: null,
    last_inbound_at: null,
    meeting_summary_count: meetingCount || 0,
    nurture_outbound_count: 0,
    last_nurture_outbound_at: null,
  };

  for (const interaction of allInteractions || []) {
    // Skip OOO system notes — they must not pollute inbound metrics
    if (interaction.type === "system_note") continue;

    const isOutbound = interaction.direction === "outbound" || interaction.type === "email_outbound";
    const isInbound = interaction.direction === "inbound" || interaction.type === "email_inbound";

    if (isOutbound) {
      if (!metrics.first_outbound_at) metrics.first_outbound_at = interaction.occurred_at;
      metrics.last_outbound_at = interaction.occurred_at;
    }
    if (isInbound) {
      metrics.last_inbound_at = interaction.occurred_at;
    }
  }

  // Get pending drafts count
  const { count: pendingDraftCount } = await serviceSupabase
    .from("drafts")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .eq("status", "pending");

  // Derive stage and action
  const newStage = deriveStage(currentStage, metrics, hasClosingKeywords);
  const actionResult = deriveAction(
    metrics,
    pendingDraftCount || 0,
    null,
    newStage,
    lead.strategy,
    (lead.strategy === "nurture" ? cadenceModes?.nurture : cadenceModes?.fast) ?? null,
  );

  // Determine last_activity_at
  const activityDates = [
    metrics.last_outbound_at,
    metrics.last_inbound_at,
  ].filter(Boolean).map(d => new Date(d!).getTime());
  
  // Only set last_activity_at from REAL activity. Falling back to now() would make a
  // lead with no imported email look freshly active on every 20-min scheduled sweep
  // (codex P1). `undefined` is dropped from the update, leaving the column as-is.
  const hasActivity = activityDates.length > 0;
  const lastActivityAt = hasActivity
    ? new Date(Math.max(...activityDates)).toISOString()
    : undefined;

  // True no-op guard: a lead with no email activity AND no meetings has nothing for
  // this function to derive — stage would be deriveStage()'s "new" default and every
  // metric would be null, so the final update would clobber a manually-advanced stage
  // (contacted/engaged/closing) and zero out fields on every 20-min scheduled run.
  // Leave the row untouched. Bounce / OOO / defer / meeting-confirmation handlers
  // above already persisted their own targeted updates, so only the derived
  // metrics/stage/action overwrite is skipped. Benefits the user "Sync now" path too.
  if (!hasActivity && metrics.meeting_summary_count === 0) {
    return { synced, errors, stage: currentStage };
  }

  // Fetch current lead state to protect nurture, OOO, unsubscribed, and automation-scheduled leads from action overwrites
  const { data: currentState } = await serviceSupabase
    .from("leads")
    .select("motion, nurture_status, ooo_until, eligible_at, needs_action, unsubscribed, next_action_key")
    .eq("id", leadId)
    .single();

  // CRITICAL: If lead is unsubscribed, never re-arm actions
  if (currentState?.unsubscribed) {
    console.log(`[gmail-bulk-sync] Lead ${leadId}: Unsubscribed — skipping action derivation`);
    // Still update metrics but never touch action fields
    const safePayload: Record<string, unknown> = {
      stage: newStage,
      first_outbound_at: metrics.first_outbound_at,
      last_outbound_at: metrics.last_outbound_at,
      meeting_summary_count: metrics.meeting_summary_count,
      last_activity_at: lastActivityAt,
    };
    await serviceSupabase.from("leads").update(safePayload).eq("id", leadId);
    return { synced, errors, stage: newStage };
  }

  const isActiveNurture = currentState?.motion === "nurture"
    && currentState?.nurture_status === "active";

  // OOO guard: if lead is currently in OOO state, do not overwrite with reply_now
  const isActiveOOO = !!currentState?.ooo_until
    && new Date(currentState.ooo_until).getTime() > Date.now();

  // Automation guard: if the automation engine has already scheduled a future step,
  // do not overwrite needs_action/next_action_key with deriveAction() result.
  // eligible_at in the future + needs_action=true means the executor has queued a send.
  const isAutomationScheduled = !!currentState?.eligible_at
    && new Date(currentState.eligible_at).getTime() > Date.now()
    && currentState?.needs_action === true;

  // CRITICAL: Recently-sent guard — if automation-executor sent an email for this lead
  // within the last 2 hours, do NOT re-arm needs_action. This prevents the loop where
  // bulk-sync re-imports the sent email, derives a new action, and triggers another send.
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { count: recentAutoSendCount } = await serviceSupabase
    .from("automation_log")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .eq("status", "sent")
    .gte("created_at", twoHoursAgo);

  const hasRecentAutoSend = (recentAutoSendCount || 0) > 0;

  // Build update payload -- always update metrics, but protect nurture/OOO/automation action fields
  const updatePayload: Record<string, unknown> = {
    stage: newStage,
    first_outbound_at: metrics.first_outbound_at,
    last_outbound_at: metrics.last_outbound_at,
    // Don't update last_inbound_at while OOO is active — OOO email is not real engagement
    last_inbound_at: isActiveOOO ? undefined : metrics.last_inbound_at,
    meeting_summary_count: metrics.meeting_summary_count,
    last_activity_at: lastActivityAt,
  };

  if (isActiveNurture) {
    // Preserve nurture automation fields -- don't overwrite with prospecting actions
    console.log(`[gmail-bulk-sync] Preserving nurture state for lead ${leadId}`);
  } else if (isActiveOOO) {
    // Preserve OOO state -- don't overwrite with reply_now derived from the OOO email
    console.log(`[gmail-bulk-sync] Lead ${leadId}: Active OOO until ${currentState.ooo_until} -- suppressing action overwrite`);
  } else if (isAutomationScheduled) {
    // Preserve automation-scheduled state -- the executor has already queued a future send.
    console.log(`[gmail-bulk-sync] Lead ${leadId}: Automation scheduled until ${currentState.eligible_at} -- suppressing action overwrite`);
  } else if (hasRecentAutoSend) {
    // CRITICAL: Recently-sent guard -- executor sent an email recently, don't re-arm.
    console.log(`[gmail-bulk-sync] Lead ${leadId}: Recent automation send detected (${recentAutoSendCount} in last 2h) -- suppressing action overwrite`);
  } else if (
    currentState?.next_action_key === RATE_LIMITED_KEY
    && currentState?.needs_action === true
    && !actionResult.needs_action
  ) {
    // Preserve an active `rate_limited` explanation (Unit Q1).
    //
    // `rate_limited` is written by the SHARED rule, which knows the workspace's
    // volume caps and this lead's recent outbound counts. This private rule has
    // neither input, so it cannot re-derive that verdict — and its `null` would
    // be written straight over it, silently turning "auto-send paused until the
    // 18th" into a blank card within one 20-minute cycle. Same defect this unit
    // exists to fix, wearing a different key.
    //
    // Same shape as the three guards above: don't overwrite what this path is
    // not equipped to evaluate. Deliberately narrow — it only holds when the
    // sweep has NOTHING of its own to say. The moment it derives anything
    // (reply_now on a fresh inbound, followup_due once the wait passes,
    // closing_followup, …) that verdict wins, so a preserved rate_limited can
    // never go stale for longer than the follow-up wait and a customer's reply
    // is never hidden behind it.
    console.log(`[gmail-bulk-sync] Lead ${leadId}: preserving rate_limited — this path has no volume-cap inputs`);
  } else if (!hasActivity && !actionResult.needs_action) {
    // No interactions on record and nothing to flag — leave existing action fields
    // untouched rather than clearing flags set elsewhere (manual / candidate) on
    // every no-op scheduled sweep (codex P1). A lead with real activity, or one
    // that derives an action, still flows through the normal overwrite below.
  } else {
    // Apply derived action for non-nurture, non-OOO, non-automation-scheduled leads
    updatePayload.needs_action = actionResult.needs_action;
    updatePayload.next_action_key = actionResult.next_action_key;
    updatePayload.next_action_label = actionResult.next_action_label;

    // THE INVARIANT (see `mustClearEligibleAt`): a prompt-only key must never be
    // persisted next to a live `eligible_at`.
    //
    // `isAutomationScheduled` above only catches a FUTURE timestamp, so an
    // enrolled lead whose `eligible_at` has already passed falls through to here
    // — and because this file never puts `eligible_at` in its payload at all,
    // the stale past timestamp survives beside the new `followup_due`. That row
    // matches automation-executor's key-agnostic query exactly, and the resolver
    // sends a generic follow-up nobody asked for. Not writing the field is the
    // bug, not the protection: null it explicitly, as buildLeadUpdate does.
    if (mustClearEligibleAt(actionResult.next_action_key)) {
      updatePayload.eligible_at = null;
    }
  }

  // CONSENT GATE (defensive): gmail-bulk-sync intentionally does NOT route through
  // syncEngine.buildLeadUpdate, so the per-lead automation_mode gate is not applied
  // here. To keep the consent contract intact even if this code is later modified,
  // we explicitly forbid this code path from ever scheduling outbound sends. The
  // updatePayload below must NEVER set `eligible_at` to a future timestamp paired
  // with `needs_action: true` and an outbound `next_action_key` — only the
  // automation-executor (which checks automation_mode IS NOT NULL) is allowed to
  // do that. OOO/defer pauses set ooo_until + needs_action:false, which is fine.
  // An explicit `eligible_at: null` is a DE-arming write — the opposite of
  // scheduling a send — so it must pass. Only a real timestamp can violate the
  // contract this gate protects.
  if (
    updatePayload.eligible_at != null &&
    updatePayload.needs_action === true &&
    typeof updatePayload.next_action_key === "string"
  ) {
    console.error(
      `[gmail-bulk-sync] CONSENT VIOLATION: refused to schedule outbound send for lead ${leadId} ` +
        `(next_action_key=${updatePayload.next_action_key}). Stripping eligible_at/needs_action/next_action_key.`,
    );
    delete updatePayload.eligible_at;
    delete updatePayload.needs_action;
    delete updatePayload.next_action_key;
    delete updatePayload.next_action_label;
  }

  // Update lead
  await serviceSupabase
    .from("leads")
    .update(updatePayload)
    .eq("id", leadId);

  return { synced, errors, stage: newStage };
}

// Resolve ALL of the connection owner's workspace memberships — gmail_connections
// has no workspace_id column, so we join through workspace_members. A rep can be
// invited to multiple workspaces, and they may own leads in each; returning only
// one membership would permanently skip the others in the scheduled sweep. The lead
// fetch still pins owner_user_id, so this only widens coverage, never isolation.
// deno-lint-ignore no-explicit-any
async function resolveWorkspaceIds(serviceSupabase: any, userId: string): Promise<string[]> {
  const { data, error } = await serviceSupabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", userId);
  if (error || !data) return [];
  const ids = (data as Array<{ workspace_id: string | null }>)
    .map((r) => r.workspace_id)
    .filter((id): id is string => !!id);
  return [...new Set(ids)];
}

// Coverage + bounding constants for the scheduled sweep.
//
// RUN_BUDGET_MS: a single run-wide wall-clock budget, checked between connections
// AND between leads, so total work is bounded regardless of how many accounts /
// leads exist. Kept under cron-dispatcher's 55s forward timeout so the dispatcher
// doesn't record every tick as a 504.
//
// LEADS_PER_PAGE: how many of a connection owner's leads one run pulls into memory.
// Coverage is guaranteed by a PERSISTED per-connection cursor (gmail_connections
// .bulk_sync_cursor): each run resumes from the cursor, syncs as many leads as the
// budget allows, then advances the cursor by the count ACTUALLY processed (mod
// total) — so a window that doesn't fit the budget resumes exactly where it stopped
// next run and no tail is ever permanently skipped. Connections are also rotated per
// tick so a long-running early account can't starve later ones. syncLeadEmails is
// idempotent (dedup by gmail_message_id), so any overlap is harmless.
const RUN_BUDGET_MS = 45_000;
const LEADS_PER_PAGE = 150;
const CRON_MAX_RESULTS = 10;

// Monotonic, ~per-tick rotation seed. The sweep cron fires every 20 min; bucketing
// wall-clock into 20-min slots gives a different starting offset each run without
// any persisted cursor. Two runs in the same slot (e.g. a manual re-trigger) reuse
// the same page — harmless, since the sync is idempotent.
function currentTickIndex(): number {
  return Math.floor(Date.now() / (20 * 60 * 1000));
}

// An account-wide Gmail auth failure (revoked token, missing read scope, refresh
// failure) fails identically for EVERY lead on that connection. Detect it so the
// scheduled sweep can flag the connection for reconnect and stop retrying per-lead.
// Same heuristic as the user-path handler's `needsReconnect` at the bottom.
function isAccountWideAuthError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("revoked") ||
    m.includes("reconnect") ||
    m.includes("reauthorize") ||
    m.includes("invalid_grant") ||
    m.includes("insufficient") ||
    m.includes("permissions") ||
    m.includes("no refresh token")
  );
}

// Scheduled (cron-dispatcher / service-role) entry path. There is no user JWT
// and the cron payload carries no leadIds, so this self-discovers every connected
// Gmail account and syncs its workspace's leads. Per-connection try/catch keeps a
// single bad account (e.g. revoked token) from aborting the whole run.
// deno-lint-ignore no-explicit-any
async function runScheduledBulkSync(serviceSupabase: any): Promise<Response> {
  const startedAt = Date.now();

  const { data: connections, error: connErr } = await serviceSupabase
    .from("gmail_connections")
    // gmail_email is the rep's mailbox address — required by the
    // direct-conversation gate in syncLeadEmails (Unit G-B P1).
    .select("user_id, gmail_email, access_token_encrypted, refresh_token_encrypted, token_expires_at, needs_reconnect, bulk_sync_cursor");

  if (connErr) {
    console.error("[gmail-bulk-sync] cron: failed to load gmail_connections:", connErr.message);
    return new Response(JSON.stringify({ ok: false, error: connErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let connectionsProcessed = 0;
  let connectionsSkipped = 0;
  // Subset of connectionsSkipped: skipped because we do not know the rep's own
  // mailbox address. Surfaced separately so it cannot hide inside a generic skip.
  let connectionsMissingAddress = 0;
  let connectionsDeferred = 0;
  let leadsProcessed = 0;
  let leadsDeferred = 0;
  let totalSynced = 0;
  let budgetExhausted = false;

  // Rotate the connection start position each tick so a long-running early account
  // can't permanently starve later ones when the run-wide budget is tight.
  const allConns = connections ?? [];
  const tick = currentTickIndex();
  const startIdx = allConns.length > 0 ? tick % allConns.length : 0;
  const rotatedConns = [...allConns.slice(startIdx), ...allConns.slice(0, startIdx)];

  for (const conn of rotatedConns) {
    // Run-wide budget: stop cleanly and report what was deferred to the next tick.
    if (Date.now() - startedAt > RUN_BUDGET_MS) {
      budgetExhausted = true;
      connectionsDeferred++;
      continue;
    }

    if (conn.needs_reconnect) {
      connectionsSkipped++;
      console.log(`[gmail-bulk-sync] cron: user=${conn.user_id} skipped (needs_reconnect)`);
      continue;
    }

    const workspaceIds = await resolveWorkspaceIds(serviceSupabase, conn.user_id);
    if (workspaceIds.length === 0) {
      connectionsSkipped++;
      console.log(`[gmail-bulk-sync] cron: user=${conn.user_id} skipped (no_workspace)`);
      continue;
    }

    // NO SILENT NO-OP. The rep↔lead gate needs this mailbox's own address and
    // fails closed without it — which, if we carried on, would walk every lead,
    // store nothing, and report a perfectly healthy `synced: 0`. A rep's history
    // would just never fill and nothing would say why. Skip loudly instead, and
    // count it, so `cron_run_log` shows a non-zero connections_missing_address.
    // ponytail: we do NOT fall back to `mail_accounts.email_address` the way the
    // interactive path's resolveGmailConnection does — that is the real fix and
    // it belongs with the wider gmail_connections → mail_accounts migration, not
    // in a bug-fix unit. Until then this is visible rather than silent.
    if (!conn.gmail_email) {
      connectionsSkipped++;
      connectionsMissingAddress++;
      console.error(
        `[gmail-bulk-sync] cron: user=${conn.user_id} SKIPPED — gmail_connections.gmail_email is empty, ` +
          `so the direct-conversation gate would reject every message and this sweep would store nothing. ` +
          `The rep must reconnect Gmail (or the row needs backfilling from mail_accounts.email_address).`,
      );
      continue;
    }

    let accessToken: string;
    try {
      accessToken = await refreshTokenIfNeeded(serviceSupabase, conn);
    } catch (err) {
      connectionsSkipped++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[gmail-bulk-sync] cron: user=${conn.user_id} token refresh failed:`, msg);
      // Self-heal: a revoked/refresh-failed token won't recover on its own, so flag
      // the connection. The needs_reconnect guard above then skips it next tick
      // instead of attempting a doomed refresh every 20 min.
      if (isAccountWideAuthError(msg)) {
        await serviceSupabase
          .from("gmail_connections")
          .update({ needs_reconnect: true })
          .eq("user_id", conn.user_id);
      }
      continue;
    }

    // Total leads OWNED BY THIS REP across ALL their workspaces — drives the rotating
    // cursor so coverage is guaranteed rather than re-scanning the same freshest rows.
    // Scope by owner_user_id (not workspace-wide): this connection's mailbox is the
    // canonical source only for leads this rep owns — the same ownership model the
    // send path uses (automation-executor resolves the Gmail connection via
    // lead.owner_user_id). The workspace_id IN (...) filter asserts current membership
    // (defense in depth) without dropping the rep's other workspaces.
    const { count: totalLeads, error: countErr } = await serviceSupabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .in("workspace_id", workspaceIds)
      .eq("owner_user_id", conn.user_id)
      .not("email", "is", null);

    if (countErr) {
      connectionsSkipped++;
      console.error(`[gmail-bulk-sync] cron: user=${conn.user_id} lead count failed:`, countErr.message);
      continue;
    }
    if (!totalLeads || totalLeads === 0) {
      connectionsProcessed++;
      continue;
    }

    // Resume from this connection's persisted cursor — a rotating offset into the
    // owner's leads (ordered by stable `id`). Advancing the cursor AFTER the loop by
    // the count actually processed means a window that doesn't fit the run budget
    // resumes exactly where it stopped next run, instead of restarting the same head
    // rows and never reaching the tail.
    const cursor = Number(conn.bulk_sync_cursor) || 0;
    const start = cursor % totalLeads;
    const end = start + LEADS_PER_PAGE - 1;

    // Service role + workspace_id IN (rep's memberships) + owner_user_id reproduce the
    // isolation the user path gets from RLS — leads never cross workspace OR rep
    // boundaries. Stable `id` order keeps the cursor window deterministic.
    const { data: leads, error: leadsErr } = await serviceSupabase
      .from("leads")
      .select("id, email, stage, strategy, workspace_id")
      .in("workspace_id", workspaceIds)
      .eq("owner_user_id", conn.user_id)
      .not("email", "is", null)
      .order("id", { ascending: true })
      .range(start, end);

    if (leadsErr) {
      connectionsSkipped++;
      console.error(`[gmail-bulk-sync] cron: user=${conn.user_id} lead fetch failed:`, leadsErr.message);
      continue;
    }

    const windowLeads = leads ?? [];
    if (totalLeads > LEADS_PER_PAGE) {
      console.log(
        `[gmail-bulk-sync] cron: user=${conn.user_id} ${totalLeads} owned leads — ` +
          `window rows ${start}-${start + Math.max(windowLeads.length - 1, 0)} this run (cursor=${cursor}).`,
      );
    }

    // Optimistic cursor: persist the offset PAST each lead BEFORE doing its work.
    // CRON_MAX_RESULTS only caps the initial Gmail search, not syncLeadEmails' walk
    // over a lead's existing locked threads — a lead with a long history can blow the
    // dispatcher's 55s / the platform wall-clock mid-lead. Advancing the cursor first
    // means such a hard kill can't re-pin the same slow lead and wedge the connection;
    // it's retried on the next full rotation instead. syncLeadEmails is idempotent.
    let accountAuthFailed = false;
    let processed = 0;
    // One read per connection per sweep — NOT per lead.
    const cadenceModes = await loadCadenceModes(serviceSupabase, conn.user_id);
    for (const lead of windowLeads) {
      // Budget reached mid-window: STOP without advancing for this lead. The cursor
      // still points at it (last persisted from the previous iteration), so the next
      // run resumes exactly here — no permanent skip.
      if (Date.now() - startedAt > RUN_BUDGET_MS) {
        budgetExhausted = true;
        leadsDeferred += windowLeads.length - processed;
        break;
      }

      // Move the persisted cursor past this lead before its (potentially slow) work.
      const nextCursor = (start + processed + 1) % totalLeads;
      await serviceSupabase
        .from("gmail_connections")
        .update({ bulk_sync_cursor: nextCursor })
        .eq("user_id", conn.user_id);

      try {
        const result = await syncLeadEmails(serviceSupabase, accessToken, lead, CRON_MAX_RESULTS, cadenceModes, conn.gmail_email);
        totalSynced += result.synced;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isAccountWideAuthError(msg)) {
          // This token fails for every lead (e.g. missing read scope). Flag the
          // connection for reconnect and stop the window — retrying the rest would
          // only burn the run budget and starve healthy connections.
          console.error(`[gmail-bulk-sync] cron: user=${conn.user_id} account-wide auth failure — flagging needs_reconnect, skipping rest of window:`, msg);
          await serviceSupabase
            .from("gmail_connections")
            .update({ needs_reconnect: true })
            .eq("user_id", conn.user_id);
          accountAuthFailed = true;
          break;
        }
        // A non-auth, lead-specific error is fine — the cursor already moved past it,
        // so it's retried on the next full rotation rather than wedging here.
        console.error(`[gmail-bulk-sync] cron: lead=${lead.id} sync failed:`, msg);
      }
      processed++;
      leadsProcessed++;
    }

    if (accountAuthFailed) {
      connectionsSkipped++;
      continue; // last_sync_at left as-is for a flagged-for-reconnect account
    }

    // Cursor is already persisted per-lead; just stamp the sync time.
    await serviceSupabase
      .from("gmail_connections")
      .update({ last_sync_at: new Date().toISOString() })
      .eq("user_id", conn.user_id);

    connectionsProcessed++;
  }

  if (budgetExhausted) {
    console.warn(
      `[gmail-bulk-sync] cron: run budget (${RUN_BUDGET_MS}ms) reached — ` +
        `${connectionsDeferred} connection(s) + ${leadsDeferred} lead(s) deferred to next tick (rotation resumes there).`,
    );
  }

  const summary = {
    ok: true,
    mode: "scheduled" as const,
    duration_ms: Date.now() - startedAt,
    budget_exhausted: budgetExhausted,
    connectionsProcessed,
    connectionsSkipped,
    connectionsMissingAddress,
    connectionsDeferred,
    leadsProcessed,
    leadsDeferred,
    totalSynced,
  };
  console.log("[gmail-bulk-sync] cron done", JSON.stringify(summary));
  return new Response(JSON.stringify(summary), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // ── Scheduled / internal branch (cron-dispatcher or service-role) ──
    // cron-dispatcher forwards with X-Internal-Secret only (no Bearer token), so
    // config.toml MUST set verify_jwt = false or the gateway 401s before we run.
    // This is the in-code auth gate; user JWTs fall through to the user path below.
    if (isInternalCaller(req) || isServiceRoleToken(req)) {
      const serviceSupabase = createClient(supabaseUrl, supabaseServiceKey);
      return await runScheduledBulkSync(serviceSupabase);
    }

    // ── User-facing branch (UI "Sync now" / per-lead sync) ──
    // With verify_jwt = false the gateway no longer enforces a JWT, so this branch
    // authenticates the user itself via getUser() below — an absent/invalid token
    // is rejected with 401, keeping the endpoint user-scoped.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, error: "Missing authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { leadIds, maxResults = 20, workspace_id: requestedWorkspaceId } = await req.json();

    if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "Missing or empty leadIds array" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[gmail-bulk-sync] Starting bulk sync for ${leadIds.length} leads`);

    // Create service role client first - needed to access encrypted tokens
    const serviceSupabase = createClient(supabaseUrl, supabaseServiceKey);

    // Resolve the caller's workspace memberships via the user-scoped client so
    // workspace_members RLS proves membership. We only resolve a workspace-scoped
    // mailbox for workspaces the caller actually belongs to.
    const { data: memberships } = await supabase
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", user.id);
    const memberWorkspaceIds = new Set<string>(
      (memberships ?? [])
        .map((m: { workspace_id: string | null }) => m.workspace_id)
        .filter((id: string | null): id is string => !!id),
    );

    // Honor an explicit workspace_id from the body (the list "Refresh" button
    // forwards it via useMailSync(workspaceId)); it must be one the caller belongs
    // to. When omitted we route EACH requested lead to its own workspace's mailbox
    // below, so a multi-workspace batch never silently drops the non-matching leads.
    const explicitWorkspaceId =
      typeof requestedWorkspaceId === "string" && requestedWorkspaceId.length > 0
        ? requestedWorkspaceId
        : null;
    if (explicitWorkspaceId && !memberWorkspaceIds.has(explicitWorkspaceId)) {
      return new Response(JSON.stringify({ ok: false, error: "No workspace found" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch the requested leads (RLS-scoped to leads the caller can access). When an
    // explicit workspace_id is given, pin to it.
    let leadsQuery = supabase
      .from("leads")
      .select("id, email, stage, strategy, workspace_id")
      .in("id", leadIds);
    if (explicitWorkspaceId) {
      leadsQuery = leadsQuery.eq("workspace_id", explicitWorkspaceId);
    }
    const { data: leadsData, error: leadsError } = await leadsQuery;

    if (leadsError || !leadsData) {
      return new Response(JSON.stringify({ ok: false, error: "Failed to fetch leads" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: Array<{ leadId: string; synced: number; stage: string; errors: string[] }> = [];
    let totalSynced = 0;
    const allErrors: string[] = [];

    if (leadsData.length === 0) {
      console.log(`[gmail-bulk-sync] No accessible leads matched the request — nothing to sync`);
      return new Response(JSON.stringify({ ok: true, totalSynced: 0, leadsProcessed: 0, results, errors: allErrors }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Group leads by workspace_id so each group syncs against ITS OWN workspace
    // mailbox. Leads with no workspace_id (legacy rows) group under null and resolve
    // via the per-user gmail_connections fallback.
    const leadsByWorkspace = new Map<string | null, typeof leadsData>();
    for (const lead of leadsData) {
      const key = (lead.workspace_id as string | null) ?? null;
      const bucket = leadsByWorkspace.get(key);
      if (bucket) bucket.push(lead);
      else leadsByWorkspace.set(key, [lead]);
    }

    let anyConnectionResolved = false;
    // One read per request — NOT per lead.
    const cadenceModes = await loadCadenceModes(serviceSupabase, user.id);

    for (const [workspaceId, groupLeads] of leadsByWorkspace) {
      // Only resolve a workspace-scoped mailbox for workspaces the caller belongs to;
      // anything else (incl. null workspace_id) falls back to legacy gmail_connections.
      const mailboxWorkspaceId =
        workspaceId && memberWorkspaceIds.has(workspaceId) ? workspaceId : null;
      const connection = await resolveGmailConnection(serviceSupabase, mailboxWorkspaceId, user.id);

      if (!connection) {
        for (const lead of groupLeads) {
          results.push({ leadId: lead.id, synced: 0, stage: lead.stage, errors: ["Gmail not connected"] });
        }
        allErrors.push(`Gmail not connected for workspace ${workspaceId ?? "(legacy)"}`);
        continue;
      }
      anyConnectionResolved = true;

      // An account-wide token failure (revoked / insufficient scope) throws here and
      // propagates to the outer catch, which sets needsReconnect — same as before.
      const accessToken = await refreshTokenIfNeeded(serviceSupabase, connection);

      for (const lead of groupLeads) {
        console.log(`[gmail-bulk-sync] Syncing lead ${lead.id} (${lead.email}) [ws=${workspaceId ?? "legacy"}]`);
        const result = await syncLeadEmails(serviceSupabase, accessToken, lead, maxResults, cadenceModes, connection.gmail_email ?? "");
        results.push({
          leadId: lead.id,
          synced: result.synced,
          stage: result.stage,
          errors: result.errors,
        });
        totalSynced += result.synced;
        allErrors.push(...result.errors);
      }

      // Stamp last_sync_at for the resolved connection.
      if (connection.source === "mail_accounts" && connection.id) {
        await serviceSupabase
          .from("mail_accounts")
          .update({ last_sync_at: new Date().toISOString() })
          .eq("id", connection.id);
      } else {
        await serviceSupabase
          .from("gmail_connections")
          .update({ last_sync_at: new Date().toISOString() })
          .eq("user_id", user.id);
      }
    }

    if (!anyConnectionResolved) {
      return new Response(JSON.stringify({ ok: false, error: "Gmail not connected" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[gmail-bulk-sync] Completed. Total synced: ${totalSynced}, Leads processed: ${leadsData.length}`);

    return new Response(JSON.stringify({
      ok: true,
      totalSynced,
      leadsProcessed: leadsData.length,
      results,
      errors: allErrors,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("[gmail-bulk-sync] Error:", err);
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    const needsReconnect = errorMessage.includes("revoked") || 
                           errorMessage.includes("reconnect") ||
                           errorMessage.includes("invalid_grant") ||
                           errorMessage.toLowerCase().includes("insufficient") ||
                           errorMessage.toLowerCase().includes("permissions");
    
    return new Response(JSON.stringify({ 
      ok: false, 
      error: errorMessage,
      needsReconnect,
    }), {
      // IMPORTANT: Keep this 200 so supabase-js `functions.invoke` does not throw.
      // The UI should rely on the JSON payload (`ok:false`, `needsReconnect:true`).
      status: needsReconnect ? 200 : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
