// ============================================================
// detect-lead-candidates — Cron-driven lead detection
//
// Scans the SENT folder of every connected mailbox (Gmail +
// Outlook) for recent outbound emails. For each external
// recipient that passes the filter chain, upserts a pending
// lead_candidate. Also surfaces inbound emails that contain
// explicit DrivePilot signals or referral language.
//
// Called by cron-dispatcher every 20 minutes.
// Auth: X-Internal-Secret header (from cron-dispatcher).
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { safeDecryptToken, encryptToken } from "../_shared/encryption.ts";
import { getFreshOutlookToken } from "../_shared/outlookTokens.ts";
import { isOutOfOfficeReply } from "../_shared/oooDetection.ts";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";
import {
  normalizeEmail,
  emailDomain,
  extractEmailsFromHeader,
  extractNameFromHeader,
  applyOutboundFilter,
  detectInboundSignals,
  makeSnippet,
  WorkspaceFilterContext,
} from "../_shared/leadCandidateDetection.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Scan window: last 25 minutes (generous overlap with 20-min cron cadence)
const SCAN_WINDOW_MS = 25 * 60 * 1000;
// Mass-send threshold per spec (candidates with >10 external recipients are skipped in V1)
const MASS_SEND_THRESHOLD = 10;
// Max messages fetched per mailbox per run (keeps execution time predictable)
const MAX_MESSAGES_PER_RUN = 30;

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// ── Helpers ─────────────────────────────────────────────────

function gmailGetHeader(
  headers: Array<{ name: string; value: string }>,
  name: string,
): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

// ── Gmail token refresh ──────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function gmailRefreshToken(serviceSupabase: any, conn: {
  user_id: string;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  token_expires_at: string;
}): Promise<string> {
  const expiresAt = new Date(conn.token_expires_at);
  const decryptedAccess = await safeDecryptToken(conn.access_token_encrypted ?? "");
  const decryptedRefresh = await safeDecryptToken(conn.refresh_token_encrypted ?? "");

  if (expiresAt.getTime() - Date.now() >= 5 * 60 * 1000) {
    return decryptedAccess;
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: decryptedRefresh,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Gmail token refresh failed (${resp.status}): ${body.slice(0, 200)}`);
  }

  const tokens = await resp.json();
  const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const hasKey = !!Deno.env.get("TOKEN_ENCRYPTION_KEY");
  const encryptedAccess = hasKey ? await encryptToken(tokens.access_token) : tokens.access_token;

  await serviceSupabase
    .from("gmail_connections")
    .update({ access_token_encrypted: encryptedAccess, token_expires_at: newExpiresAt })
    .eq("user_id", conn.user_id);

  return tokens.access_token;
}

// ── Filter context loader ────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function loadFilterContext(
  serviceSupabase: any,
  workspaceId: string,
  repEmail: string,
): Promise<WorkspaceFilterContext> {
  const repDomain = emailDomain(repEmail);

  const [
    { data: gmailConns },
    { data: outlookAccounts },
    { data: internalDomainRows },
    { data: dismissedEmailRows },
    { data: dismissedDomainRows },
    { data: leadRows },
  ] = await Promise.all([
    // Collect email addresses of all workspace members via their connected Gmail accounts
    serviceSupabase
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId)
      .then(({ data: members }: { data: Array<{ user_id: string }> | null }) => {
        if (!members || members.length === 0) return { data: [] };
        return serviceSupabase
          .from("gmail_connections")
          .select("gmail_email")
          .in("user_id", members.map(m => m.user_id));
      }),
    // Outlook accounts for this workspace
    serviceSupabase
      .from("mail_accounts")
      .select("email_address")
      .eq("workspace_id", workspaceId)
      .eq("provider", "outlook"),
    // Configured extra-internal domains
    serviceSupabase
      .from("workspace_internal_domains")
      .select("domain")
      .eq("workspace_id", workspaceId),
    // Always-reject email list
    serviceSupabase
      .from("workspace_dismissed_emails")
      .select("email")
      .eq("workspace_id", workspaceId),
    // Always-reject domain list
    serviceSupabase
      .from("workspace_dismissed_domains")
      .select("domain")
      .eq("workspace_id", workspaceId),
    // Known leads (exact email match)
    serviceSupabase
      .from("leads")
      .select("email")
      .eq("workspace_id", workspaceId)
      .not("email", "is", null),
  ]);

  const memberEmails = new Set<string>();
  for (const r of gmailConns ?? []) memberEmails.add(r.gmail_email.toLowerCase().trim());
  for (const r of outlookAccounts ?? []) memberEmails.add(r.email_address.toLowerCase().trim());

  const internalDomains = new Set<string>([repDomain]);
  for (const r of internalDomainRows ?? []) internalDomains.add(r.domain.toLowerCase().trim());

  const dismissedEmails = new Set<string>();
  for (const r of dismissedEmailRows ?? []) dismissedEmails.add(normalizeEmail(r.email));

  const dismissedDomains = new Set<string>();
  for (const r of dismissedDomainRows ?? []) dismissedDomains.add(r.domain.toLowerCase().trim());

  const existingLeadEmails = new Set<string>();
  for (const r of leadRows ?? []) {
    if (r.email) existingLeadEmails.add(normalizeEmail(r.email));
  }

  return { workspaceId, memberEmails, internalDomains, dismissedEmails, dismissedDomains, existingLeadEmails };
}

// ── Candidate upsert ─────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function upsertCandidate(serviceSupabase: any, {
  workspaceId, ownerUserId, contactEmail, contactName, companyDomain,
  source, emailDate, subjectSnippet, bodySnippet,
}: {
  workspaceId: string;
  ownerUserId: string | null;
  contactEmail: string;
  contactName: string | null;
  companyDomain: string | null;
  source: "outbound" | "inbound_explicit" | "inbound_referral";
  emailDate: Date;
  subjectSnippet: string;
  bodySnippet: string;
}): Promise<"inserted" | "updated" | "skipped"> {
  const normalized = normalizeEmail(contactEmail);

  // Check for an existing non-approved candidate for this email in this workspace
  const { data: existing } = await serviceSupabase
    .from("lead_candidates")
    .select("id, status, resolved_at, email_count")
    .eq("workspace_id", workspaceId)
    .eq("contact_email", normalized)
    .neq("status", "approved")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    if (existing.status === "pending" || existing.status === "snoozed") {
      await serviceSupabase
        .from("lead_candidates")
        .update({
          last_email_at: emailDate.toISOString(),
          email_count: (existing.email_count ?? 1) + 1,
          subject_snippet: subjectSnippet,
          body_snippet: bodySnippet,
        })
        .eq("id", existing.id);
      return "updated";
    }

    if (existing.status === "dismissed") {
      const resolvedAt = existing.resolved_at ? new Date(existing.resolved_at) : null;
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      if (!resolvedAt || resolvedAt > ninetyDaysAgo) {
        return "skipped"; // still in dismiss cooldown
      }
      // 90+ days passed — fall through to re-insert
    }
  }

  const { error } = await serviceSupabase.from("lead_candidates").insert({
    workspace_id: workspaceId,
    owner_user_id: ownerUserId,
    contact_email: normalized,
    contact_name: contactName,
    company_domain: companyDomain,
    source,
    first_seen_at: emailDate.toISOString(),
    last_email_at: emailDate.toISOString(),
    email_count: 1,
    subject_snippet: subjectSnippet,
    body_snippet: bodySnippet,
    status: "pending",
  });

  if (error) {
    if (error.code === "23505") return "skipped"; // partial-index conflict (race)
    throw error;
  }

  return "inserted";
}

// ── Gmail detection ──────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function scanGmail(
  serviceSupabase: any,
  conn: { user_id: string; gmail_email: string; [k: string]: unknown },
  accessToken: string,
  workspaceId: string,
  ctx: WorkspaceFilterContext,
  scanSince: Date,
): Promise<{ inserted: number; updated: number; skipped: number }> {
  const repEmail = conn.gmail_email.toLowerCase().trim();
  const stats = { inserted: 0, updated: 0, skipped: 0 };

  // Fetch recent sent + recent inbox message IDs in one search
  // SENT scan (outbound candidates)
  const sentQuery = encodeURIComponent("in:sent");
  const sentUrl =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${sentQuery}&maxResults=${MAX_MESSAGES_PER_RUN}`;
  const sentResp = await fetch(sentUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!sentResp.ok) {
    const err = await sentResp.text();
    console.warn(`[detect-lead-candidates] Gmail SENT search failed for ${repEmail}: ${err.slice(0, 200)}`);
    return stats;
  }
  const sentData = await sentResp.json();
  const sentIds: string[] = (sentData.messages ?? []).map((m: { id: string }) => m.id);

  // INBOX scan (inbound candidates with explicit signals)
  const inboxQuery = encodeURIComponent("in:inbox");
  const inboxUrl =
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${inboxQuery}&maxResults=${MAX_MESSAGES_PER_RUN}`;
  const inboxResp = await fetch(inboxUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const inboxData = inboxResp.ok ? await inboxResp.json() : {};
  const inboxIds: string[] = (inboxData.messages ?? []).map((m: { id: string }) => m.id);

  // Process SENT messages
  for (const msgId of sentIds) {
    try {
      const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=From,To,Cc,Subject,Date`;
      const msgResp = await fetch(msgUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!msgResp.ok) continue;

      const msg = await msgResp.json();
      const internalDate = parseInt(msg.internalDate ?? "0");
      if (internalDate < scanSince.getTime()) continue; // too old

      const headers: Array<{ name: string; value: string }> = msg.payload?.headers ?? [];
      const from = gmailGetHeader(headers, "From");
      const toRaw = gmailGetHeader(headers, "To");
      const ccRaw = gmailGetHeader(headers, "Cc");
      const subject = gmailGetHeader(headers, "Subject") || "(no subject)";
      const dateHeader = gmailGetHeader(headers, "Date");
      const emailDate = dateHeader ? new Date(dateHeader) : new Date(internalDate);
      const snippet = makeSnippet(msg.snippet ?? "");

      // Only process messages sent by this rep
      const fromEmails = extractEmailsFromHeader(from);
      if (!fromEmails.includes(repEmail)) continue;

      // Collect all To + Cc recipients
      const allTo = [
        ...extractEmailsFromHeader(toRaw),
        ...extractEmailsFromHeader(ccRaw),
      ];

      // Count external recipients (pass the filter chain)
      const external = allTo.filter(e => applyOutboundFilter(e, ctx).pass);

      if (external.length > MASS_SEND_THRESHOLD) {
        console.log(`[detect-lead-candidates] Skipping mass-send to ${external.length} recipients (msg ${msgId})`);
        continue;
      }

      for (const recipEmail of external) {
        // Best-effort name extraction from To header
        const recipName = allTo.length === 1 ? extractNameFromHeader(toRaw) : null;
        const domain = emailDomain(recipEmail);
        const action = await upsertCandidate(serviceSupabase, {
          workspaceId,
          ownerUserId: conn.user_id,
          contactEmail: recipEmail,
          contactName: recipName,
          companyDomain: domain || null,
          source: "outbound",
          emailDate,
          subjectSnippet: makeSnippet(subject, 200),
          bodySnippet: snippet,
        });
        stats[action]++;
      }
    } catch (err) {
      console.error(`[detect-lead-candidates] Error processing Gmail SENT msg ${msgId}:`, err);
    }
  }

  // Process INBOX messages (inbound signals only)
  for (const msgId of inboxIds) {
    try {
      const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=metadata&metadataHeaders=From,To,Subject,Date,Auto-Submitted,List-Unsubscribe`;
      const msgResp = await fetch(msgUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!msgResp.ok) continue;

      const msg = await msgResp.json();
      const internalDate = parseInt(msg.internalDate ?? "0");
      if (internalDate < scanSince.getTime()) continue;

      const headers: Array<{ name: string; value: string }> = msg.payload?.headers ?? [];
      const from = gmailGetHeader(headers, "From");
      const toRaw = gmailGetHeader(headers, "To");
      const subject = gmailGetHeader(headers, "Subject") || "";
      const dateHeader = gmailGetHeader(headers, "Date");
      const emailDate = dateHeader ? new Date(dateHeader) : new Date(internalDate);
      const snippet = msg.snippet ?? "";

      // Must be addressed to the rep
      const toEmails = extractEmailsFromHeader(toRaw);
      if (!toEmails.includes(repEmail)) continue;

      // Skip newsletters and auto-replies
      if (gmailGetHeader(headers, "List-Unsubscribe")) continue;
      const autoSub = gmailGetHeader(headers, "Auto-Submitted").toLowerCase();
      if (autoSub && autoSub !== "no") continue;

      // OOO detection using subject only (we only have snippet, not full body)
      const oooCheck = isOutOfOfficeReply(headers, subject, snippet);
      if (oooCheck.isOOO) continue;

      // Check inbound signals
      const signals = detectInboundSignals(subject, snippet);
      if (!signals.hasSignal) continue;

      const fromEmails = extractEmailsFromHeader(from);
      const senderEmail = fromEmails[0];
      if (!senderEmail) continue;

      // Apply filter chain (same as outbound — skip teammates, dismissed, etc.)
      const filter = applyOutboundFilter(senderEmail, ctx);
      if (!filter.pass) continue;

      const senderName = extractNameFromHeader(from);
      const domain = emailDomain(senderEmail);
      const action = await upsertCandidate(serviceSupabase, {
        workspaceId,
        ownerUserId: conn.user_id,
        contactEmail: senderEmail,
        contactName: senderName,
        companyDomain: domain || null,
        source: signals.source!,
        emailDate,
        subjectSnippet: makeSnippet(subject, 200),
        bodySnippet: makeSnippet(snippet),
      });
      stats[action]++;
    } catch (err) {
      console.error(`[detect-lead-candidates] Error processing Gmail INBOX msg ${msgId}:`, err);
    }
  }

  return stats;
}

// ── Outlook detection ────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function scanOutlook(
  serviceSupabase: any,
  account: { id: string; workspace_id: string; email_address: string },
  accessToken: string,
  ctx: WorkspaceFilterContext,
  scanSince: Date,
): Promise<{ inserted: number; updated: number; skipped: number }> {
  const repEmail = account.email_address.toLowerCase().trim();
  const stats = { inserted: 0, updated: 0, skipped: 0 };
  const filterDate = scanSince.toISOString();

  // Sent items
  const sentUrl =
    `${GRAPH_BASE}/me/mailFolders/sentItems/messages` +
    `?$filter=sentDateTime ge '${filterDate}'` +
    `&$top=${MAX_MESSAGES_PER_RUN}` +
    `&$select=id,subject,bodyPreview,from,toRecipients,ccRecipients,sentDateTime,internetMessageHeaders`;

  const sentResp = await fetch(sentUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, ConsistencyLevel: "eventual" },
  });

  if (sentResp.ok) {
    const sentData = await sentResp.json();
    const messages = sentData.value ?? [];

    for (const msg of messages) {
      try {
        const emailDate = new Date(msg.sentDateTime);
        const subject = msg.subject || "(no subject)";
        const snippet = makeSnippet(msg.bodyPreview ?? "");

        const fromEmail = msg.from?.emailAddress?.address?.toLowerCase().trim() ?? "";
        if (fromEmail !== repEmail) continue; // shouldn't happen for sentItems, but guard it

        const allTo: string[] = [
          ...(msg.toRecipients ?? []).map((r: { emailAddress: { address: string } }) =>
            r.emailAddress?.address?.toLowerCase().trim()).filter(Boolean),
          ...(msg.ccRecipients ?? []).map((r: { emailAddress: { address: string } }) =>
            r.emailAddress?.address?.toLowerCase().trim()).filter(Boolean),
        ];

        const external = allTo.filter(e => applyOutboundFilter(e, ctx).pass);
        if (external.length > MASS_SEND_THRESHOLD) {
          console.log(`[detect-lead-candidates] Skipping mass-send to ${external.length} recipients (Outlook msg ${msg.id})`);
          continue;
        }

        for (const recipEmail of external) {
          const recipName =
            allTo.length === 1
              ? (msg.toRecipients?.[0]?.emailAddress?.name ?? null)
              : null;
          const domain = emailDomain(recipEmail);
          const action = await upsertCandidate(serviceSupabase, {
            workspaceId: account.workspace_id,
            ownerUserId: null, // Outlook mail_accounts have no user_id
            contactEmail: recipEmail,
            contactName: recipName,
            companyDomain: domain || null,
            source: "outbound",
            emailDate,
            subjectSnippet: makeSnippet(subject, 200),
            bodySnippet: snippet,
          });
          stats[action]++;
        }
      } catch (err) {
        console.error(`[detect-lead-candidates] Error processing Outlook sent msg ${msg.id}:`, err);
      }
    }
  } else {
    const err = await sentResp.text();
    console.warn(`[detect-lead-candidates] Outlook sentItems failed for ${repEmail}: ${err.slice(0, 200)}`);
  }

  // Inbox (inbound signals)
  const inboxUrl =
    `${GRAPH_BASE}/me/mailFolders/inbox/messages` +
    `?$filter=receivedDateTime ge '${filterDate}'` +
    `&$top=${MAX_MESSAGES_PER_RUN}` +
    `&$select=id,subject,bodyPreview,from,toRecipients,receivedDateTime,internetMessageHeaders`;

  const inboxResp = await fetch(inboxUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, ConsistencyLevel: "eventual" },
  });

  if (inboxResp.ok) {
    const inboxData = await inboxResp.json();
    const messages = inboxData.value ?? [];

    for (const msg of messages) {
      try {
        const emailDate = new Date(msg.receivedDateTime);
        const subject = msg.subject || "";
        const snippet = msg.bodyPreview ?? "";

        // Skip newsletters (List-Unsubscribe header)
        const headers: Array<{ name: string; value: string }> = msg.internetMessageHeaders ?? [];
        const hasListUnsub = headers.some(h => h.name.toLowerCase() === "list-unsubscribe");
        if (hasListUnsub) continue;
        const autoSub = headers.find(h => h.name.toLowerCase() === "auto-submitted")?.value.toLowerCase() ?? "";
        if (autoSub && autoSub !== "no") continue;

        // OOO detection
        const oooCheck = isOutOfOfficeReply(headers, subject, snippet);
        if (oooCheck.isOOO) continue;

        // Inbound signals
        const signals = detectInboundSignals(subject, snippet);
        if (!signals.hasSignal) continue;

        const senderEmail = msg.from?.emailAddress?.address?.toLowerCase().trim();
        if (!senderEmail) continue;

        const filter = applyOutboundFilter(senderEmail, ctx);
        if (!filter.pass) continue;

        const senderName = msg.from?.emailAddress?.name ?? null;
        const domain = emailDomain(senderEmail);
        const action = await upsertCandidate(serviceSupabase, {
          workspaceId: account.workspace_id,
          ownerUserId: null,
          contactEmail: senderEmail,
          contactName: senderName,
          companyDomain: domain || null,
          source: signals.source!,
          emailDate,
          subjectSnippet: makeSnippet(subject, 200),
          bodySnippet: makeSnippet(snippet),
        });
        stats[action]++;
      } catch (err) {
        console.error(`[detect-lead-candidates] Error processing Outlook inbox msg ${msg.id}:`, err);
      }
    }
  }

  return stats;
}

// ── Main handler ─────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = requireScheduledCaller(req, corsHeaders);
  if (auth instanceof Response) return auth;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // deno-lint-ignore no-explicit-any
  const serviceSupabase: any = createClient(supabaseUrl, supabaseServiceKey);

  const scanSince = new Date(Date.now() - SCAN_WINDOW_MS);
  const startedAt = Date.now();
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  const errors: string[] = [];

  // ── Gmail connections ────────────────────────────────────
  const { data: gmailConns, error: gmailConnErr } = await serviceSupabase
    .from("gmail_connections")
    .select("user_id, gmail_email, access_token_encrypted, refresh_token_encrypted, token_expires_at");

  if (gmailConnErr) {
    errors.push(`Failed to load gmail_connections: ${gmailConnErr.message}`);
  }

  for (const conn of gmailConns ?? []) {
    try {
      // Resolve workspace for this Gmail user
      const { data: membership } = await serviceSupabase
        .from("workspace_members")
        .select("workspace_id")
        .eq("user_id", conn.user_id)
        .limit(1)
        .maybeSingle();

      if (!membership) {
        console.log(`[detect-lead-candidates] No workspace for Gmail user ${conn.user_id}, skipping`);
        continue;
      }

      const workspaceId = membership.workspace_id;
      const ctx = await loadFilterContext(serviceSupabase, workspaceId, conn.gmail_email);
      const accessToken = await gmailRefreshToken(serviceSupabase, conn);
      const stats = await scanGmail(serviceSupabase, conn, accessToken, workspaceId, ctx, scanSince);

      totalInserted += stats.inserted;
      totalUpdated += stats.updated;
      totalSkipped += stats.skipped;

      console.log(
        `[detect-lead-candidates] Gmail ${conn.gmail_email}: +${stats.inserted} new, ${stats.updated} refreshed, ${stats.skipped} skipped`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[detect-lead-candidates] Gmail ${conn.gmail_email} error:`, msg);
      errors.push(`Gmail ${conn.gmail_email}: ${msg.slice(0, 200)}`);
    }
  }

  // ── Outlook mail accounts ────────────────────────────────
  const { data: outlookAccounts, error: outlookErr } = await serviceSupabase
    .from("mail_accounts")
    .select("id, workspace_id, email_address")
    .eq("provider", "outlook")
    .eq("status", "connected");

  if (outlookErr) {
    errors.push(`Failed to load mail_accounts: ${outlookErr.message}`);
  }

  for (const account of outlookAccounts ?? []) {
    try {
      const ctx = await loadFilterContext(serviceSupabase, account.workspace_id, account.email_address);

      let accessToken: string;
      try {
        accessToken = await getFreshOutlookToken(account.id, serviceSupabase);
      } catch (tokenErr) {
        const msg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
        console.warn(`[detect-lead-candidates] Outlook token error for ${account.email_address}: ${msg}`);
        errors.push(`Outlook ${account.email_address}: token error — ${msg.slice(0, 100)}`);
        continue;
      }

      const stats = await scanOutlook(serviceSupabase, account, accessToken, ctx, scanSince);

      totalInserted += stats.inserted;
      totalUpdated += stats.updated;
      totalSkipped += stats.skipped;

      console.log(
        `[detect-lead-candidates] Outlook ${account.email_address}: +${stats.inserted} new, ${stats.updated} refreshed, ${stats.skipped} skipped`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[detect-lead-candidates] Outlook ${account.email_address} error:`, msg);
      errors.push(`Outlook ${account.email_address}: ${msg.slice(0, 200)}`);
    }
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `[detect-lead-candidates] Done in ${durationMs}ms — inserted:${totalInserted} updated:${totalUpdated} skipped:${totalSkipped} errors:${errors.length}`,
  );

  return new Response(
    JSON.stringify({
      ok: true,
      inserted: totalInserted,
      updated: totalUpdated,
      skipped: totalSkipped,
      duration_ms: durationMs,
      errors: errors.length > 0 ? errors : undefined,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
