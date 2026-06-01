import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { safeDecryptToken, encryptToken } from "../_shared/encryption.ts";
import { isOutOfOfficeReply, detectDeferSignal } from "../_shared/oooDetection.ts";
import { applyOOOPause, applyDeferPause } from "../_shared/oooPauseActions.ts";
import { detectMeetingConfirmation } from "../_shared/meetingConfirmation.ts";
import { isHumanUnsubscribeRequest } from "../_shared/unsubscribeDetection.ts";
import { createCanonicalInteraction } from "../_shared/canonicalInteraction.ts";
import { emailDedupeKey } from "../_shared/timelineProjector.ts";
import { extractEmailsFromHeader } from "../_shared/emailUtils.ts";

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

// deno-lint-ignore no-explicit-any
async function refreshTokenIfNeeded(
  supabase: any,
  connection: { user_id: string; access_token_encrypted: string | null; refresh_token_encrypted: string | null; token_expires_at: string }
): Promise<string> {
  const expiresAt = new Date(connection.token_expires_at);
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
    
    // Encrypt the new access token before storage
    let encryptedNewAccessToken = tokens.access_token;
    try {
      const hasEncryptionKey = !!Deno.env.get("TOKEN_ENCRYPTION_KEY");
      if (hasEncryptionKey) {
        encryptedNewAccessToken = await encryptToken(tokens.access_token);
      }
    } catch (encryptError) {
      console.error("[gmail-bulk-sync] Token encryption failed, storing in plaintext:", encryptError);
    }
    
    await supabase
      .from("gmail_connections")
      .update({
        access_token_encrypted: encryptedNewAccessToken,
        token_expires_at: newExpiresAt,
      })
      .eq("user_id", connection.user_id);
    
    return tokens.access_token;
  }
  
  return decryptedAccessToken;
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

function deriveAction(
  metrics: LeadMetrics,
  pendingDraftCount: number,
  nurtureCadence: string | null,
  stage: string
): { needs_action: boolean; next_action_key: string | null; next_action_label: string | null } {
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  if (metrics.last_inbound_at) {
    const inboundTime = new Date(metrics.last_inbound_at).getTime();
    const outboundTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
    
    if (inboundTime > outboundTime) {
      const elapsed = now - inboundTime;
      if (elapsed > 6 * HOUR) {
        return {
          needs_action: true,
          next_action_key: "reply_now",
          next_action_label: "Reply to customer",
        };
      }
    }
  }

  // Closing stage - follow up if no outbound in 3 days
  if (stage === "closing") {
    const lastOutTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
    if (now - lastOutTime > 3 * DAY) {
      return {
        needs_action: true,
        next_action_key: "closing_followup",
        next_action_label: "Follow up on proposal/contract",
      };
    }
  }

  if (metrics.first_outbound_at && !metrics.last_inbound_at && metrics.meeting_summary_count === 0) {
    const firstOutTime = new Date(metrics.first_outbound_at).getTime();
    const lastOutTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : firstOutTime;
    const daysSinceFirst = (now - firstOutTime) / DAY;
    const daysSinceLast = (now - lastOutTime) / DAY;

    if (daysSinceFirst >= 14 && daysSinceLast >= 7) {
      return {
        needs_action: true,
        next_action_key: "send_pre_4",
        next_action_label: "Send breakup email",
      };
    } else if (daysSinceFirst >= 7 && daysSinceLast >= 4) {
      return {
        needs_action: true,
        next_action_key: "send_pre_3",
        next_action_label: "Send follow-up Email 3",
      };
    } else if (daysSinceFirst >= 4 && daysSinceLast >= 3) {
      return {
        needs_action: true,
        next_action_key: "send_pre_2",
        next_action_label: "Send follow-up Email 2",
      };
    }
  }

  if (metrics.meeting_summary_count > 0) {
    const lastOutTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
    if (now - lastOutTime > 48 * HOUR) {
      return {
        needs_action: true,
        next_action_key: "generate_post_meeting_recap",
        next_action_label: "Send post-meeting recap",
      };
    }
  }

  if (metrics.nurture_outbound_count > 0 && nurtureCadence) {
    const lastNurtureTime = metrics.last_nurture_outbound_at 
      ? new Date(metrics.last_nurture_outbound_at).getTime() 
      : 0;
    
    let intervalDays = 7;
    if (nurtureCadence === "biweekly") intervalDays = 14;
    else if (nurtureCadence === "monthly") intervalDays = 30;

    if (now - lastNurtureTime >= intervalDays * DAY) {
      return {
        needs_action: true,
        next_action_key: `send_nurture_${metrics.nurture_outbound_count + 1}`,
        next_action_label: "Send nurture email",
      };
    }
  }

  return { needs_action: false, next_action_key: null, next_action_label: null };
}

// deno-lint-ignore no-explicit-any
async function syncLeadEmails(
  serviceSupabase: any,
  accessToken: string,
  lead: { id: string; email: string; stage: string; strategy: string; workspace_id?: string | null },
  maxResults: number
): Promise<{ synced: number; errors: string[]; stage: string }> {
  const { id: leadId, email: leadEmail, stage: currentStage } = lead;
  const workspaceId = lead.workspace_id ?? null;
  const leadEmailNorm = typeof leadEmail === "string" ? leadEmail.trim() : "";
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

  // Search for emails from/to this lead
  const query = `from:${leadEmailNorm} OR to:${leadEmailNorm}`;
  const searchUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`;
  
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
  const messageIds = searchData.messages || [];
  
  console.log(`[gmail-bulk-sync] Found ${messageIds.length} messages for ${leadEmailNorm}`);

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
      
      if (!messageInvolvesLead(headers, leadEmailNorm)) {
        console.warn(
          `[gmail-bulk-sync] Skipping message ${gmailMessageId} (does not involve lead email ${leadEmailNorm})`
        );
        continue;
      }

      const from = getHeader(headers, "From") || "";
      const to = getHeader(headers, "To") || "";
      const cc = getHeader(headers, "Cc") || "";
      const toEmailsArr = extractEmailsFromHeader(to);
      const ccEmailsArr = extractEmailsFromHeader(cc);
      const subject = getHeader(headers, "Subject") || "(no subject)";
      const date = getHeader(headers, "Date");
      const occurredAt = date ? new Date(date).toISOString() : new Date(parseInt(message.internalDate)).toISOString();

      const isFromLead = from.toLowerCase().includes(leadEmailNorm.toLowerCase());
      const direction = isFromLead ? "inbound" : "outbound";
      const type = isFromLead ? "email_inbound" : "email_outbound";

      const bodyText = getMessageBody(message);

      if (direction === "inbound" && containsClosingKeywords(bodyText + " " + subject)) {
        hasClosingKeywords = true;
      }

      // Bounce / undeliverable detection
      const fromLower = from.toLowerCase();
      const subjectLower = subject.toLowerCase();
      const isBounce = (
        fromLower.includes("postmaster") ||
        fromLower.includes("mailer-daemon") ||
        fromLower.includes("mail delivery") ||
        subjectLower.includes("delivery status notification") ||
        subjectLower.includes("undeliverable") ||
        subjectLower.includes("mail delivery failed") ||
        subjectLower.includes("returned mail") ||
        subjectLower.includes("failure notice") ||
        subjectLower.includes("delivery failure")
      );

      if (isBounce) {
        console.log(`[gmail-bulk-sync] Lead ${leadId}: Bounce detected (subject: "${subject}") — stopping automation`);
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
            provider: "automation",
          });
      }

      // OOO / Auto-reply detection — must run BEFORE counting as real inbound
      if (direction === "inbound" && !isBounce) {
        const oooResult = isOutOfOfficeReply(headers, subject, bodyText);
        const applied = await applyOOOPause({
          supabase: serviceSupabase,
          leadId,
            workspaceId,
          oooResult,
          occurredAt,
          gmailMessageId,
          gmailThreadId: threadId,
          logPrefix: "[gmail-bulk-sync]",
        });
        if (applied) {
          existingMessageIds.add(gmailMessageId);
          synced++;
          continue;
        }
      }

      // ── Defer / "reconnect later" detection ──
      if (direction === "inbound" && !isBounce) {
        const deferResult = detectDeferSignal(bodyText, new Date(occurredAt));
        await applyDeferPause({
          supabase: serviceSupabase,
          leadId,
          workspaceId: null,
          deferResult,
          logPrefix: "[gmail-bulk-sync]",
        });
      }

      // ── Meeting confirmation detection ──
      if (direction === "inbound" && !isBounce) {
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
        provider: "gmail",
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

  // Fetch messages from locked threads
  for (const threadId of lockedThreadIds) {
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
        const existingBody = existingBodyByMessageId.get(gmailMessageId);
        const shouldRestorePurgedBody = existingMessageIds.has(gmailMessageId) && (!existingBody || existingBody.trim() === "");
        if (existingMessageIds.has(gmailMessageId) && !shouldRestorePurgedBody) continue;

        const headers = message.payload?.headers || [];
        if (!messageInvolvesLead(headers, leadEmailNorm)) {
          console.warn(
            `[gmail-bulk-sync] Skipping thread message ${gmailMessageId} in thread ${threadId} (does not involve lead email ${leadEmailNorm})`
          );
          continue;
        }

        const from = getHeader(headers, "From") || "";
        const to = getHeader(headers, "To") || "";
        const cc = getHeader(headers, "Cc") || "";
        const toEmailsArr = extractEmailsFromHeader(to);
        const ccEmailsArr = extractEmailsFromHeader(cc);
        const subject = getHeader(headers, "Subject") || "(no subject)";
        const date = getHeader(headers, "Date");
        const occurredAt = date ? new Date(date).toISOString() : new Date(parseInt(message.internalDate)).toISOString();

        const isFromLead = from.toLowerCase().includes(leadEmailNorm.toLowerCase());
        const direction = isFromLead ? "inbound" : "outbound";
        const type = isFromLead ? "email_inbound" : "email_outbound";

        const bodyText = getMessageBody(message);

        if (direction === "inbound" && containsClosingKeywords(bodyText + " " + subject)) {
          hasClosingKeywords = true;
        }

        // Bounce / undeliverable detection in thread messages
        const fromLowerT = from.toLowerCase();
        const subjectLowerT = subject.toLowerCase();
        const isBounceT = (
          fromLowerT.includes("postmaster") ||
          fromLowerT.includes("mailer-daemon") ||
          fromLowerT.includes("mail delivery") ||
          subjectLowerT.includes("delivery status notification") ||
          subjectLowerT.includes("undeliverable") ||
          subjectLowerT.includes("mail delivery failed") ||
          subjectLowerT.includes("returned mail") ||
          subjectLowerT.includes("failure notice") ||
          subjectLowerT.includes("delivery failure")
        );

        if (isBounceT) {
          console.log(`[gmail-bulk-sync] Lead ${leadId}: Bounce detected in thread (subject: "${subject}") — stopping automation`);
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
            lead_id: leadId, type: "system_note", source: "automation",
            body_text: `Email bounced/undeliverable (subject: "${subject}") — automation stopped permanently. Please verify the email address.`,
            occurred_at: new Date().toISOString(), workspace_id: workspaceId, provider: "automation",
          });
        }

        // OOO detection in thread messages
        if (direction === "inbound" && !isBounceT) {
          const oooResultT = isOutOfOfficeReply(headers, subject, bodyText);
          const applied = await applyOOOPause({
            supabase: serviceSupabase,
            leadId,
            workspaceId,
            oooResult: oooResultT,
            occurredAt,
            gmailMessageId,
            gmailThreadId: threadId,
            logPrefix: "[gmail-bulk-sync:thread]",
          });
          if (applied) {
            existingMessageIds.add(gmailMessageId);
            synced++;
            continue;
          }
        }

        // ── Defer detection in thread messages ──
        if (direction === "inbound" && !isBounceT) {
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
        if (direction === "inbound" && !isBounceT) {
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
  const actionResult = deriveAction(metrics, pendingDraftCount || 0, null, newStage);

  // Determine last_activity_at
  const activityDates = [
    metrics.last_outbound_at,
    metrics.last_inbound_at,
  ].filter(Boolean).map(d => new Date(d!).getTime());
  
  const lastActivityAt = activityDates.length > 0 
    ? new Date(Math.max(...activityDates)).toISOString()
    : new Date().toISOString();

  // Fetch current lead state to protect nurture, OOO, unsubscribed, and automation-scheduled leads from action overwrites
  const { data: currentState } = await serviceSupabase
    .from("leads")
    .select("motion, nurture_status, ooo_until, eligible_at, needs_action, unsubscribed")
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
  } else {
    // Apply derived action for non-nurture, non-OOO, non-automation-scheduled leads
    updatePayload.needs_action = actionResult.needs_action;
    updatePayload.next_action_key = actionResult.next_action_key;
    updatePayload.next_action_label = actionResult.next_action_label;
  }

  // CONSENT GATE (defensive): gmail-bulk-sync intentionally does NOT route through
  // syncEngine.buildLeadUpdate, so the per-lead automation_mode gate is not applied
  // here. To keep the consent contract intact even if this code is later modified,
  // we explicitly forbid this code path from ever scheduling outbound sends. The
  // updatePayload below must NEVER set `eligible_at` to a future timestamp paired
  // with `needs_action: true` and an outbound `next_action_key` — only the
  // automation-executor (which checks automation_mode IS NOT NULL) is allowed to
  // do that. OOO/defer pauses set ooo_until + needs_action:false, which is fine.
  if (
    "eligible_at" in updatePayload &&
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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, error: "Missing authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
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

    const { leadIds, maxResults = 20 } = await req.json();
    
    if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "Missing or empty leadIds array" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[gmail-bulk-sync] Starting bulk sync for ${leadIds.length} leads`);

    // Create service role client first - needed to access encrypted tokens
    const serviceSupabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get Gmail connection using service role (column-level security blocks token access for regular users)
    const { data: connection, error: connError } = await serviceSupabase
      .from("gmail_connections")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (connError || !connection) {
      return new Response(JSON.stringify({ ok: false, error: "Gmail not connected" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accessToken = await refreshTokenIfNeeded(serviceSupabase, connection);

    // Get leads data
    const { data: leadsData, error: leadsError } = await supabase
      .from("leads")
      .select("id, email, stage, strategy")
      .in("id", leadIds);

    if (leadsError || !leadsData) {
      return new Response(JSON.stringify({ ok: false, error: "Failed to fetch leads" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: Array<{ leadId: string; synced: number; stage: string; errors: string[] }> = [];
    let totalSynced = 0;
    const allErrors: string[] = [];

    // Process each lead
    for (const lead of leadsData) {
      console.log(`[gmail-bulk-sync] Syncing lead ${lead.id} (${lead.email})`);
      
      const result = await syncLeadEmails(serviceSupabase, accessToken, lead, maxResults);
      
      results.push({
        leadId: lead.id,
        synced: result.synced,
        stage: result.stage,
        errors: result.errors,
      });
      
      totalSynced += result.synced;
      allErrors.push(...result.errors);
    }

    // Update last_sync_at for the connection
    await serviceSupabase
      .from("gmail_connections")
      .update({ last_sync_at: new Date().toISOString() })
      .eq("user_id", user.id);

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
