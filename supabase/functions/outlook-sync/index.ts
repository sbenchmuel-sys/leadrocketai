// ============================================================
// outlook-sync — Mirror of gmail-sync for Outlook/Graph API
//
// Fetches messages from Microsoft Graph, stores as interactions,
// derives stage/action, and runs all safeguards:
//   - Direct conversation filter (rep ↔ lead only)
//   - Newsletter guard (List-Unsubscribe)
//   - Bounce detection
//   - OOO detection
//   - Unsubscribe detection (human opt-out phrases only)
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getFreshOutlookToken } from "../_shared/outlookTokens.ts";
import { isOutOfOfficeReply, detectDeferSignal } from "../_shared/oooDetection.ts";
import { applyOOOPause, applyDeferPause } from "../_shared/oooPauseActions.ts";
import { detectMeetingConfirmation } from "../_shared/meetingConfirmation.ts";
import { captureWinningInteraction } from "../_shared/winningInteractions.ts";
import { projectTimelineItem, emailDedupeKey } from "../_shared/timelineProjector.ts";
import { createCanonicalInteraction } from "../_shared/canonicalInteraction.ts";
import {
  type LeadMetrics,
  type LeadUpdate,
  DEFAULT_CADENCE_SETTINGS,
  deepMergeCadence,
  extractEmailAddresses,
  htmlToPlainText,
  containsClosingKeywords,
  getCorsHeaders,
  deriveStage,
  deriveAction,
  computeMetricsFromInteractions,
  buildLeadUpdate,
} from "../_shared/syncEngine.ts";

// ============================================
// Graph API helpers
// ============================================

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface GraphMessage {
  id: string;
  conversationId: string;
  subject: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  from: { emailAddress: { address: string; name: string } };
  toRecipients: Array<{ emailAddress: { address: string; name: string } }>;
  ccRecipients?: Array<{ emailAddress: { address: string; name: string } }>;
  receivedDateTime: string;
  sentDateTime: string;
  internetMessageId: string;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  isDraft: boolean;
}

function getGraphMessageBody(msg: GraphMessage): string {
  if (msg.body.contentType === "text") return msg.body.content || msg.bodyPreview || "";
  return htmlToPlainText(msg.body.content || "") || msg.bodyPreview || "";
}

function getInternetHeader(msg: GraphMessage, name: string): string | undefined {
  return msg.internetMessageHeaders?.find(
    h => h.name.toLowerCase() === name.toLowerCase()
  )?.value;
}

// ============================================
// MAIN HANDLER
// ============================================

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, error: "Missing authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
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
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { leadId, leadEmail, maxResults = 20 } = await req.json();
    const leadEmailNorm = typeof leadEmail === "string" ? leadEmail.trim().toLowerCase() : "";

    if (!leadId || !leadEmailNorm) {
      return new Response(JSON.stringify({ ok: false, error: "Missing leadId or leadEmail" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceSupabase = createClient(supabaseUrl, supabaseServiceKey);

    // Find the Outlook mail_account for this user's workspace
    // First get the user's workspace
    const { data: membership } = await supabase
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();

    if (!membership) {
      return new Response(JSON.stringify({ ok: false, error: "No workspace found" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: mailAccount } = await serviceSupabase
      .from("mail_accounts")
      .select("*")
      .eq("workspace_id", membership.workspace_id)
      .eq("provider", "outlook")
      .eq("status", "connected")
      .order("is_default", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!mailAccount) {
      return new Response(JSON.stringify({ ok: false, error: "Outlook not connected" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get current lead data
    const { data: leadData } = await supabase
      .from("leads")
      .select("stage, strategy, owner_user_id, has_future_meeting, action_dismissed_at, created_at, motion, nurture_status, ooo_until, workspace_id")
      .eq("id", leadId)
      .single();

    const currentStage = leadData?.stage || "new";
    const strategy = leadData?.strategy || "fast";
    const ownerUserId = leadData?.owner_user_id || user.id;
    const hasFutureMeeting = leadData?.has_future_meeting || false;
    const actionDismissedAt = leadData?.action_dismissed_at || null;
    const leadMotion = leadData?.motion || "outbound_prospecting";

    // Get fresh access token
    let accessToken: string;
    try {
      accessToken = await getFreshOutlookToken(mailAccount.id, serviceSupabase);
    } catch (tokenErr) {
      const errMsg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
      const needsReconnect = errMsg.includes("expired") || errMsg.includes("reauthorize");
      return new Response(JSON.stringify({ ok: false, error: errMsg, needsReconnect }), {
        status: needsReconnect ? 200 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const repEmail = (mailAccount.email_address || "").toLowerCase().trim();

    // Search messages involving the lead email (30 days before lead creation)
    const leadCreatedAt = leadData?.created_at ? new Date(leadData.created_at) : new Date();
    const syncStartDate = new Date(leadCreatedAt);
    syncStartDate.setDate(syncStartDate.getDate() - 30);
    const syncStartMs = syncStartDate.getTime();
    const filterDate = syncStartDate.toISOString();

    // Graph API: use $search (KQL) to find any message involving the lead email.
    // Microsoft Graph does NOT allow combining $filter on toRecipients/any(...) with
    // other filters — it returns ErrorInvalidUrlQueryFilter. $search works across
    // from/to/cc/bcc and is the supported way to query participants.
    // Note: $search cannot be combined with $filter or $orderby. We sort + date-filter
    // client-side below (already done in the loop).
    const searchKql = `"participants:${leadEmailNorm}"`;
    const graphUrl = `${GRAPH_BASE}/me/messages?$search=${encodeURIComponent(searchKql)}&$top=${maxResults}&$select=id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,internetMessageId,isDraft,internetMessageHeaders`;

    const searchResp = await fetch(graphUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.body-content-type="text"',
        ConsistencyLevel: "eventual",
      },
    });

    if (!searchResp.ok) {
      const errorText = await searchResp.text();
      console.error("[outlook-sync] Search failed:", errorText);
      const needsReconnect = searchResp.status === 401 || searchResp.status === 403;
      return new Response(JSON.stringify({
        ok: false,
        error: needsReconnect ? "Outlook permissions need updating - please reauthorize" : "Outlook search failed",
        needsReconnect,
      }), {
        status: needsReconnect ? 200 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const searchData = await searchResp.json();
    const messages: GraphMessage[] = searchData.value || [];

    console.log(`[outlook-sync] Found ${messages.length} messages for ${leadEmailNorm}`);

    // Get existing message IDs for dedup (use internetMessageId as the stable key)
    const { data: existingInteractions } = await supabase
      .from("interactions")
      .select("gmail_message_id, body_text")
      .eq("lead_id", leadId)
      .not("gmail_message_id", "is", null);

    const existingMessageIds = new Set(
      (existingInteractions || []).map(i => i.gmail_message_id)
    );
    const existingBodyByMessageId = new Map(
      (existingInteractions || []).map(i => [i.gmail_message_id, i.body_text])
    );

    let synced = 0;
    const errors: string[] = [];
    let hasClosingKeywords = false;

    for (const msg of messages) {
      // Use internetMessageId as stable dedup key (falls back to Graph id)
      const messageId = msg.internetMessageId || msg.id;
      const existingBody = existingBodyByMessageId.get(messageId);
      const shouldRestorePurgedBody = existingMessageIds.has(messageId) && (!existingBody || existingBody.trim() === "");
      if (existingMessageIds.has(messageId) && !shouldRestorePurgedBody) continue;
      if (msg.isDraft) continue;

      try {
        const fromEmail = msg.from?.emailAddress?.address?.toLowerCase().trim() || "";
        const toEmails = (msg.toRecipients || []).map(r => r.emailAddress?.address?.toLowerCase().trim()).filter(Boolean);
        const ccEmails = (msg.ccRecipients || []).map(r => r.emailAddress?.address?.toLowerCase().trim()).filter(Boolean);

        // STRICT DIRECTION FILTER: Only direct rep ↔ lead conversation
        const isFromLead = fromEmail === leadEmailNorm;
        const isFromRep = fromEmail === repEmail;
        const isToLead = toEmails.includes(leadEmailNorm);
        const isToRep = toEmails.includes(repEmail);
        const isDirectConversation = (isFromLead && isToRep) || (isFromRep && isToLead);

        // Bounce/DSN messages come FROM postmaster/mailer-daemon, not the lead, so
        // they'd be dropped here before isBounce runs — and the bounce-stop +
        // bounced_at stamp (the circuit breaker's signal) would never fire. Let
        // likely bounces through; the isBounce block below still does the handling.
        const _fromL = fromEmail;
        const _subjL = (msg.subject || "").toLowerCase();
        const isLikelyBounce =
          _fromL.includes("postmaster") ||
          _fromL.includes("mailer-daemon") ||
          _fromL.includes("mail delivery") ||
          _subjL.includes("delivery status notification") ||
          _subjL.includes("undeliverable") ||
          _subjL.includes("mail delivery failed") ||
          _subjL.includes("returned mail") ||
          _subjL.includes("failure notice") ||
          _subjL.includes("delivery failure");

        if (!isDirectConversation && !isLikelyBounce) {
          console.log(`[outlook-sync] Skipping 3rd-party message ${msg.id} (from: "${fromEmail}", to: "${toEmails.join(",")}")`);
          continue;
        }

        // Server-side date guard (use whichever timestamp Graph provides)
        const tsRaw = msg.receivedDateTime || msg.sentDateTime;
        const msgTimestamp = tsRaw ? new Date(tsRaw).getTime() : NaN;
        if (Number.isFinite(msgTimestamp) && msgTimestamp < syncStartMs) continue;

        const subject = msg.subject || "(no subject)";
        const occurredAt = msg.sentDateTime || msg.receivedDateTime;
        const direction = isFromLead ? "inbound" : "outbound";
        const type = isFromLead ? "email_inbound" : "email_outbound";
        const bodyText = getGraphMessageBody(msg);

        // Convert internet headers to array format for OOO detection
        const headersArr = (msg.internetMessageHeaders || []).map(h => ({ name: h.name, value: h.value }));

        // Closing keywords
        if (direction === "inbound" && containsClosingKeywords(bodyText + " " + subject)) {
          hasClosingKeywords = true;
        }

        // BOUNCE detection
        const fromLower = fromEmail;
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
          console.log(`[outlook-sync] Lead ${leadId}: Bounce detected — stopping automation`);
          await serviceSupabase.from("leads").update({
            unsubscribed: true, needs_action: false, eligible_at: null,
            next_action_key: null, next_action_label: null, action_reason_code: null,
            nurture_status: "inactive",
          }).eq("id", leadId);

          await createCanonicalInteraction(serviceSupabase, {
            lead_id: leadId,
            type: "system_note",
            source: "automation",
            body_text: `Email bounced/undeliverable (subject: "${subject}") — automation stopped permanently.`,
            occurred_at: new Date().toISOString(),
            workspace_id: leadData?.workspace_id ?? null,
            provider: "automation",
          });

          // Cold outreach (Unit C): mark the lead's STARTED enrollment(s) bounced +
          // stopped so the scheduler's bounce-rate circuit breaker can act. Reuses
          // THIS detection (no new bounce list). No-op for non-enrolled leads.
          // Constrained to current_step_number >= 1 (i.e. ≥1 touch actually sent) so
          // the numerator matches the breaker's denominator — a not-yet-started
          // (scheduled, step 0) enrollment bouncing on an unrelated email must not
          // count toward a campaign's bounce rate.
          await serviceSupabase.from("campaign_enrollment")
            .update({ bounced_at: new Date().toISOString(), status: "stopped" })
            .eq("lead_id", leadId)
            .gte("current_step_number", 1);
        }

        // OOO detection
        if (direction === "inbound" && !isBounce) {
          const oooResult = isOutOfOfficeReply(headersArr, subject, bodyText);
          const applied = await applyOOOPause({
            supabase: serviceSupabase,
            leadId,
            workspaceId: leadData?.workspace_id ?? null,
            oooResult,
            occurredAt,
            gmailMessageId: messageId,
            gmailThreadId: msg.conversationId,
            logPrefix: "[outlook-sync]",
          });
          if (applied) {
            existingMessageIds.add(messageId);
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
            workspaceId: leadData?.workspace_id ?? null,
            deferResult,
            logPrefix: "[outlook-sync]",
          });
        }

        // ── Meeting confirmation detection ──
        if (direction === "inbound" && !isBounce) {
          const meetingResult = detectMeetingConfirmation(subject, bodyText);
          if (meetingResult.isConfirmed) {
            // Body-aware override (EDGE_CASES #4): see gmail-sync for the
            // detailed rationale. When a calendar-accept also contains a
            // substantive commercial question, keep needs_action open.
            const override = meetingResult.hasSubstantiveQuestion;
            const leadUpdate: Record<string, unknown> = { has_future_meeting: true };
            if (!override) leadUpdate.needs_action = false;

            console.log(
              `[outlook-sync] Lead ${leadId}: Meeting confirmed (${meetingResult.confidence}): "${meetingResult.matchedText}"`
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
              workspace_id: leadData?.workspace_id ?? null,
              provider: "automation",
            });

            // Capture last outbound as winning interaction
            const { data: lastOutbound } = await serviceSupabase
              .from("interactions")
              .select("body_text")
              .eq("lead_id", leadId)
              .eq("direction", "outbound")
              .order("occurred_at", { ascending: false })
              .limit(1)
              .maybeSingle();

            if (lastOutbound?.body_text) {
              captureWinningInteraction({
                supabaseAdmin: serviceSupabase,
                userId: ownerUserId,
                leadId,
                messageContent: lastOutbound.body_text,
                channel: "email",
                outcomeType: "meeting_booked",
              });
            }
          }
        }

        // UNSUBSCRIBE detection (human opt-out only, skip newsletters)
        const hasListUnsubscribeHeader = !!getInternetHeader(msg, "List-Unsubscribe");
        if (direction === "inbound" && !hasListUnsubscribeHeader) {
          const bodyLower = bodyText.toLowerCase();
          if (/\bstop\s+emailing\b/.test(bodyLower) || /\bremove\s+me\b/.test(bodyLower) || /\bplease\s+(don['']t|do\s+not|stop)\s+(email|contact|reach)\b/.test(bodyLower)) {
            console.log(`[outlook-sync] Lead ${leadId}: Unsubscribe keyword detected`);
            await serviceSupabase.from("leads").update({
              unsubscribed: true, needs_action: false, eligible_at: null,
              next_action_key: null, next_action_label: null, action_reason_code: null,
              nurture_status: "inactive",
            }).eq("id", leadId);

            await createCanonicalInteraction(serviceSupabase, {
              lead_id: leadId,
              type: "system_note",
              source: "automation",
              body_text: "Lead requested to unsubscribe — automation stopped permanently.",
              occurred_at: new Date().toISOString(),
              workspace_id: leadData?.workspace_id ?? null,
              provider: "automation",
            });
          }
        }

        const canonResult = await createCanonicalInteraction(serviceSupabase, {
          lead_id: leadId,
          type,
          source: "outlook",
          body_text: bodyText.substring(0, 10000),
          occurred_at: occurredAt,
          direction,
          subject,
          from_email: msg.from?.emailAddress?.address || "",
          to_email: toEmails.join(", "),
          to_emails: toEmails as string[],
          cc_emails: ccEmails as string[],
          gmail_message_id: messageId,
          gmail_thread_id: msg.conversationId,
          workspace_id: leadData?.workspace_id ?? null,
          provider: "outlook",
          metadata_json: { provider_message_id: messageId, conversation_id: msg.conversationId, from_email: msg.from?.emailAddress?.address },
          dedupe_key: emailDedupeKey("outlook", messageId, messageId),
        });

        if (canonResult.error && canonResult.error !== "duplicate") {
          errors.push(`Failed to insert message ${msg.id}: ${canonResult.error}`);
        } else if (!canonResult.error) {
          synced++;
          existingMessageIds.add(messageId);
        }
      } catch (err) {
        errors.push(`Error processing message ${msg.id}: ${err instanceof Error ? err.message : "Unknown"}`);
      }
    }

    // ============================================
    // COMPUTE DERIVED METRICS (via shared syncEngine)
    // ============================================

    const { data: allInteractions } = await serviceSupabase
      .from("interactions")
      .select("type, direction, occurred_at, body_text")
      .eq("lead_id", leadId)
      .order("occurred_at", { ascending: true });

    const { data: meetingPacks } = await serviceSupabase
      .from("meeting_packs")
      .select("id, follow_up_email_body, meeting_date, created_at")
      .eq("lead_id", leadId);

    const meetingCount = meetingPacks?.length || 0;

    let hasMeetingWithoutFollowup = false;
    for (const mp of meetingPacks || []) {
      if (mp.follow_up_email_body && mp.follow_up_email_body.trim() !== "") continue;
      const referenceDate = mp.meeting_date || (mp as any).created_at;
      if (referenceDate) {
        const { data: postMeetingEmails } = await serviceSupabase
          .from("interactions")
          .select("id")
          .eq("lead_id", leadId)
          .eq("direction", "outbound")
          .gt("occurred_at", referenceDate)
          .limit(1);
        if (postMeetingEmails && postMeetingEmails.length > 0) {
          await serviceSupabase
            .from("meeting_packs")
            .update({ follow_up_email_body: "[Sent via Outlook]", follow_up_email_subject: "Follow-up" })
            .eq("id", mp.id);
          continue;
        }
      }
      hasMeetingWithoutFollowup = true;
    }

    // Use shared metrics computation
    const metricsResult = computeMetricsFromInteractions(allInteractions || [], meetingCount);
    const metrics = metricsResult.metrics;
    if (metricsResult.hasClosingKeywords) hasClosingKeywords = true;

    const { data: pendingDrafts } = await serviceSupabase
      .from("drafts")
      .select("id, nurture_cadence")
      .eq("lead_id", leadId)
      .in("status", ["pending", "saved"]);

    const nurtureCadence = pendingDrafts?.find(d => d.nurture_cadence)?.nurture_cadence ||
      (strategy === "nurture" ? "weekly" : null);

    const { data: workspaceProfile } = await serviceSupabase
      .from("workspace_profiles")
      .select("cadence_settings, meeting_timezone")
      .eq("user_id", ownerUserId)
      .maybeSingle();

    const cadenceSettings = deepMergeCadence(DEFAULT_CADENCE_SETTINGS, workspaceProfile?.cadence_settings || {});
    const timezone = workspaceProfile?.meeting_timezone || null;
    const modeSettings = cadenceSettings.modes[strategy as 'fast' | 'nurture'] || cadenceSettings.modes.fast;

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const recentOutbound7d = (allInteractions || []).filter(i =>
      i.direction === 'outbound' && new Date(i.occurred_at).getTime() > now - 7 * DAY
    ).length;
    const recentOutbound30d = (allInteractions || []).filter(i =>
      i.direction === 'outbound' && new Date(i.occurred_at).getTime() > now - 30 * DAY
    ).length;

    // Derive stage and action
    const stage = deriveStage(currentStage, metrics, hasClosingKeywords);

    // EDGE_CASES #1: `hasFutureMeeting` was read from `leadData` before the
    // per-message loop. If a meeting-confirmation in this batch set
    // has_future_meeting=true, the local stays stale and the
    // pause_when_meeting_scheduled guard in deriveAction misses until the
    // next sync. Re-read fresh from the DB right before deriveAction.
    const { data: refreshedLead } = await serviceSupabase
      .from("leads").select("has_future_meeting").eq("id", leadId).maybeSingle();
    const freshHasFutureMeeting = refreshedLead?.has_future_meeting ?? hasFutureMeeting;

    const actionResult = deriveAction(
      leadId, metrics, nurtureCadence, stage, hasMeetingWithoutFollowup, freshHasFutureMeeting,
      recentOutbound7d, recentOutbound30d, modeSettings, cadenceSettings.guardrails,
      cadenceSettings.stop_pause_rules, cadenceSettings.flows, timezone, strategy, leadMotion
    );

    // Use shared lead update builder (handles dismissal, active automation, OOO)
    const { data: currentLeadState } = await serviceSupabase
      .from("leads")
      .select("eligible_at, needs_action, motion, nurture_status, ooo_until, automation_mode")
      .eq("id", leadId)
      .single();

    const leadUpdate = buildLeadUpdate(
      stage, metrics, actionResult, actionDismissedAt,
      currentLeadState ? {
        needs_action: currentLeadState.needs_action,
        eligible_at: currentLeadState.eligible_at,
        motion: currentLeadState.motion,
        nurture_status: currentLeadState.nurture_status,
        ooo_until: currentLeadState.ooo_until,
      } : null,
      currentLeadState?.automation_mode ?? null,
    );

    await serviceSupabase.from("leads").update(leadUpdate).eq("id", leadId);

    // Update last_sync_at
    await serviceSupabase.from("mail_accounts").update({ last_sync_at: new Date().toISOString() }).eq("id", mailAccount.id);

    console.log(`[outlook-sync] Synced ${synced} messages, stage=${stage}, needs_action=${actionResult.needs_action}`);

    return new Response(
      JSON.stringify({
        ok: true, synced, total: messages.length, stage,
        needs_action: actionResult.needs_action,
        next_action_key: actionResult.next_action_key,
        eligible_at: actionResult.eligible_at,
        action_reason_code: actionResult.action_reason_code,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorId = crypto.randomUUID();
    const errorMessage = error instanceof Error ? error.message : "An error occurred while syncing emails";
    const needsReconnect =
      errorMessage.toLowerCase().includes("expired") ||
      errorMessage.toLowerCase().includes("revoked") ||
      errorMessage.toLowerCase().includes("reauthorize") ||
      errorMessage.toLowerCase().includes("permissions");

    console.error(`[outlook-sync] Error ${errorId}:`, error);
    return new Response(
      JSON.stringify({ ok: false, error: errorMessage, error_id: errorId, needsReconnect }),
      {
        status: needsReconnect ? 200 : 500,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      }
    );
  }
});
