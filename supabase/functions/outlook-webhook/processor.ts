// ============================================================
// outlook-webhook processor — heavy POST-path logic
//
// Loaded via dynamic import() from index.ts so the validation
// GET path never pays the cold-start cost of these modules.
//
// Two notification kinds arrive on the same endpoint:
//   1. Change notifications (a message was created/updated)
//      — distinguished by absence of `lifecycleEvent`.
//   2. Lifecycle notifications (subscription needs reauth,
//      was removed by Graph, or we missed events while down)
//      — distinguished by presence of `lifecycleEvent`.
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";
import { getFreshOutlookToken } from "../_shared/outlookTokens.ts";
import { logger } from "../_shared/logger.ts";
import { isOutOfOfficeReply, detectDeferSignal } from "../_shared/oooDetection.ts";
import { applyOOOPause, applyDeferPause } from "../_shared/oooPauseActions.ts";
import {
  hasSubstantiveQuestion,
  SUBSTANTIVE_QUESTION_FLAG,
} from "../_shared/inboundIntentDetectors.ts";
import { detectMeetingConfirmation } from "../_shared/meetingConfirmation.ts";
import { isHumanUnsubscribeRequest, stripQuotedReply } from "../_shared/unsubscribeDetection.ts";
import { createCanonicalInteraction } from "../_shared/canonicalInteraction.ts";
import { outlookEmailDedupeKey } from "../_shared/dedupeKeys.ts";
import { pickPrimaryLead } from "../_shared/leadResolution.ts";

// How many duplicate lead rows for one address we will act on. Production's
// largest group today is 3; this is a sanity bound, not a business rule. If it
// is ever hit the log line below says so.
const DUPLICATE_LEAD_SCAN_LIMIT = 25;
import {
  renewOutlookSubscription,
  SUBSCRIPTION_LIFETIME_MS,
} from "../_shared/outlookSubscription.ts";

// Strip HTML tags for plain-text body_text
// preserveNewlines: keep line breaks instead of flattening everything to single spaces.
// Needed for unsubscribe quote-stripping — stripQuotedReply keys off LINE-ANCHORED markers
// ("On … wrote:", "From:"/"Sent:" header blocks, "____" dividers, ">" quotes), so a flattened
// single-line body matches none of them and our own quoted pitch can re-trigger a false
// opt-out. All other consumers (OOO / defer / meeting detection, stored body) keep the
// default flattened form so their phrase matching is unaffected.
function htmlToPlainText(html: string, preserveNewlines = false): string {
  let text = html;
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;/gi, " ");
  text = text.replace(/&amp;/gi, "&");
  text = text.replace(/&lt;/gi, "<");
  text = text.replace(/&gt;/gi, ">");
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  if (preserveNewlines) {
    text = text.replace(/[ \t\f\v ]+/g, " "); // collapse horizontal runs only
    text = text.replace(/[ \t]*\n[ \t]*/g, "\n");  // trim spaces hugging newlines
    text = text.replace(/\n{3,}/g, "\n\n");        // cap blank-line runs
  } else {
    text = text.replace(/\s+/g, " ");
  }
  return text.trim();
}

function getServiceClient(): ReturnType<typeof createClient> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(supabaseUrl, supabaseServiceKey);
}

// ============================================================
// Entry point — dispatches change vs lifecycle notifications.
// ============================================================
export async function handleNotifications(notifications: unknown[]): Promise<void> {
  const serviceClient = getServiceClient();

  for (const raw of notifications) {
    const notification = raw as Record<string, unknown>;
    try {
      if (typeof notification.lifecycleEvent === "string") {
        await handleLifecycleEvent(notification, serviceClient);
      } else {
        await processChangeNotification(notification, serviceClient);
      }
    } catch (err) {
      logger.error("mail.outlook.webhook_process_error", {
        error: err instanceof Error ? err.message : String(err),
        lifecycle_event: notification.lifecycleEvent ?? null,
        subscription_id: notification.subscriptionId ?? null,
      });
    }
  }
}

// ============================================================
// Lifecycle event handler
//
// Graph sends one of:
//   - reauthorizationRequired: the user's token needs to prove
//     it's still valid. We refresh and PATCH to extend the sub.
//   - subscriptionRemoved: Graph deleted the sub (token revoked,
//     consent withdrawn, repeated webhook failures, etc.). We
//     mark our row 'removed' so the next cron run creates a fresh one.
//   - missed: notifications were dropped (Graph or webhook outage).
//     We log it; the next routine sync will backfill.
// ============================================================
async function handleLifecycleEvent(
  notification: Record<string, unknown>,
  serviceClient: ReturnType<typeof createClient>
): Promise<void> {
  const subscriptionId = notification.subscriptionId as string | undefined;
  const lifecycleEvent = notification.lifecycleEvent as string;
  const notifClientState = (notification.clientState as string) ?? "";

  if (!subscriptionId) {
    logger.warn("mail.outlook.lifecycle_missing_subscription_id", { notification });
    return;
  }

  const { data: sub } = await serviceClient
    .from("outlook_subscriptions")
    .select("id, mail_account_id, client_state, status, error_count")
    .eq("subscription_id", subscriptionId)
    .maybeSingle();

  if (!sub) {
    logger.warn("mail.outlook.lifecycle_unknown_subscription", {
      subscription_id: subscriptionId,
      lifecycle_event: lifecycleEvent,
    });
    return;
  }

  if (sub.client_state && notifClientState !== sub.client_state) {
    logger.warn("mail.outlook.lifecycle_invalid_client_state", {
      subscription_id: subscriptionId,
      lifecycle_event: lifecycleEvent,
    });
    return;
  }

  const mailAccountId = sub.mail_account_id as string;

  logger.info("mail.outlook.lifecycle_received", {
    mail_account_id: mailAccountId,
    subscription_id: subscriptionId,
    lifecycle_event: lifecycleEvent,
  });

  if (lifecycleEvent === "reauthorizationRequired") {
    // Refresh the access token, then PATCH the subscription to extend
    // its expiration. The PATCH itself acts as proof that we still have
    // a valid delegated token — Graph reauthorizes the sub server-side.
    try {
      const accessToken = await getFreshOutlookToken(mailAccountId, serviceClient);
      await renewOutlookSubscription(
        mailAccountId,
        subscriptionId,
        sub.id as string,
        accessToken,
        serviceClient
      );
      logger.info("mail.outlook.lifecycle_reauthorized", {
        mail_account_id: mailAccountId,
        subscription_id: subscriptionId,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error("mail.outlook.lifecycle_reauth_failed", {
        mail_account_id: mailAccountId,
        subscription_id: subscriptionId,
        error: reason,
      });
      // Bump error_count but do NOT escalate the account here — the
      // subscription-check cron will retry on its own schedule, with
      // the same tolerance policy.
      await serviceClient
        .from("outlook_subscriptions")
        .update({
          error_reason: reason,
          error_count: ((sub as { error_count?: number }).error_count ?? 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("id", sub.id as string);
    }
    return;
  }

  if (lifecycleEvent === "subscriptionRemoved") {
    // Graph dropped the sub on their side. Mark our row so the next
    // cron run knows to CREATE rather than try to PATCH a dead id.
    // We do NOT recreate inline — CREATE requires the 10s validation
    // handshake which is the whole class of failure we're insulating.
    await serviceClient
      .from("outlook_subscriptions")
      .update({
        status: "removed",
        error_reason: "subscriptionRemoved lifecycle event",
        updated_at: new Date().toISOString(),
      })
      .eq("id", sub.id as string);
    logger.info("mail.outlook.lifecycle_subscription_removed", {
      mail_account_id: mailAccountId,
      subscription_id: subscriptionId,
    });
    return;
  }

  if (lifecycleEvent === "missed") {
    // We may have missed notifications. The next routine sync run
    // will catch up; we just record it for observability here.
    const expiry = notification.subscriptionExpirationDateTime as string | undefined;
    // Light sanity check — if the sub is about to expire AND we're
    // already inside the renewal window, opportunistically extend.
    if (expiry) {
      const msUntilExpiry = new Date(expiry).getTime() - Date.now();
      if (msUntilExpiry < SUBSCRIPTION_LIFETIME_MS / 2) {
        try {
          const accessToken = await getFreshOutlookToken(mailAccountId, serviceClient);
          await renewOutlookSubscription(
            mailAccountId,
            subscriptionId,
            sub.id as string,
            accessToken,
            serviceClient
          );
        } catch (err) {
          logger.warn("mail.outlook.lifecycle_missed_renew_failed", {
            mail_account_id: mailAccountId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return;
  }

  logger.warn("mail.outlook.lifecycle_unknown_event", {
    mail_account_id: mailAccountId,
    subscription_id: subscriptionId,
    lifecycle_event: lifecycleEvent,
  });
}

// ============================================================
// Change notification handler
// (the prior `processNotification` body, unchanged in behavior)
// ============================================================
async function processChangeNotification(
  notification: Record<string, unknown>,
  serviceClient: ReturnType<typeof createClient>
): Promise<void> {
  const resourceData = notification.resourceData as Record<string, unknown> | undefined;
  const providerMessageId = (resourceData?.id as string) ?? "";
  const subscriptionId = notification.subscriptionId as string;
  const changeType = (notification.changeType as string) ?? "created";
  const notifClientState = (notification.clientState as string) ?? "";

  if (!providerMessageId) {
    logger.warn("mail.outlook.webhook_missing_message_id", { notification });
    return;
  }

  // --- 1. Resolve subscription + validate clientState ---
  const { data: sub } = await serviceClient
    .from("outlook_subscriptions")
    .select("id, mail_account_id, client_state")
    .eq("subscription_id", subscriptionId)
    .eq("status", "active")
    .maybeSingle();

  if (!sub) {
    logger.warn("mail.outlook.webhook_unknown_subscription", { subscription_id: subscriptionId });
    return;
  }

  if (sub.client_state && notifClientState !== sub.client_state) {
    logger.warn("mail.outlook.webhook_invalid_client_state", {
      subscription_id: subscriptionId,
      expected: sub.client_state,
      received: notifClientState,
    });
    return;
  }

  const mailAccountId: string = sub.mail_account_id as string;

  // --- 2. Idempotency check ---
  //
  // This asks a DIFFERENT question from the dedupe key: not "do we hold this
  // message" but "have we already processed this NOTIFICATION". The right
  // identity for that is the Graph message id, which is per-mailbox — so the
  // lookup is scoped to the mailbox that owns it. Without that scope the match
  // was global, and a Graph id colliding across two mailboxes would silently
  // drop the second tenant's notification as already-seen. Graph ids embed the
  // mailbox store so that should not happen, but a global match on a
  // per-mailbox id is the same class of mistake this unit has been fixing, and
  // narrowing it can only ever stop mail being dropped — a genuine duplicate is
  // still caught downstream by the dedupe key.
  const { data: existing } = await serviceClient
    .from("mail_event_log")
    .select("id")
    .eq("provider", "outlook")
    .eq("mail_account_id", mailAccountId)
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();

  if (existing) {
    logger.info("mail.outlook.webhook_duplicate_skipped", { provider_message_id: providerMessageId });
    return;
  }

  // --- 3. Get mail account email + WORKSPACE (needed for the direct
  //        conversation filter and for workspace-scoping every lead lookup) ---
  const { data: mailAccount } = await serviceClient
    .from("mail_accounts")
    .select("email_address, workspace_id")
    .eq("id", mailAccountId)
    .single();

  const repEmail = (mailAccount as { email_address?: string } | null)?.email_address?.toLowerCase().trim() || "";

  // WORKSPACE ISOLATION (Unit G-B P1).
  //
  // Every lead lookup below used to be `.eq("email", …)` with no workspace
  // filter. `leads.email` is not globally unique — the same contact can exist
  // as a lead in several tenants — so an inbound message could be attached to
  // ANOTHER workspace's lead, and that workspace's automation paused/stopped
  // by mail it never received. This is the mailbox's workspace, and it is the
  // only workspace this notification may write to.
  //
  // FAIL CLOSED: no workspace on the mailbox row means we cannot prove which
  // tenant this mail belongs to, so we process nothing rather than guess.
  const mailboxWorkspaceId =
    (mailAccount as { workspace_id?: string | null } | null)?.workspace_id ?? null;
  if (!mailboxWorkspaceId) {
    logger.warn("mail.outlook.webhook_no_mailbox_workspace", {
      mail_account_id: mailAccountId,
      provider_message_id: providerMessageId,
    });
    return;
  }

  // --- 4. Fetch full message from Graph (with headers + body for safeguards) ---
  let senderEmail: string | null = null;
  let messageSubject: string | null = null;
  let conversationId: string | null = null;
  // RFC 2822 Message-ID. The stable cross-path identity of this message:
  // outlook-sync keys on it too, so both paths must derive the SAME
  // dedupe key from it or the same email is stored twice (Unit G-B P1).
  let internetMessageId: string | null = null;
  // The time the message actually arrived, per Graph. The webhook used to
  // stamp `occurred_at = now()`, which is the time WE processed it — wrong
  // whenever a notification is delayed or replayed, and it puts the row in
  // the wrong place in the lead's timeline.
  let receivedAt: string | null = null;
  let bodyText = "";
  let bodyTextLined = ""; // newline-preserving copy, used only for unsubscribe quote-stripping
  let toRecipients: string[] = [];
  let ccRecipients: string[] = [];
  let internetMessageHeaders: Array<{ name: string; value: string }> = [];

  try {
    const accessToken = await getFreshOutlookToken(mailAccountId, serviceClient);
    const msgResp = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${providerMessageId}?$select=id,subject,from,toRecipients,ccRecipients,conversationId,receivedDateTime,internetMessageId,body,internetMessageHeaders`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (msgResp.ok) {
      const msg = await msgResp.json();
      senderEmail = msg.from?.emailAddress?.address?.toLowerCase() ?? null;
      messageSubject = msg.subject ?? null;
      conversationId = msg.conversationId ?? null;
      internetMessageId = msg.internetMessageId ?? null;
      // Guard against an unparseable value — an invalid Date would serialise
      // to a throw, and a bad timestamp is worse than falling back to now().
      const received = msg.receivedDateTime ? new Date(msg.receivedDateTime) : null;
      receivedAt = received && !Number.isNaN(received.getTime()) ? received.toISOString() : null;

      if (msg.body?.content) {
        bodyText = msg.body.contentType === "html"
          ? htmlToPlainText(msg.body.content)
          : msg.body.content;
        // Newline-preserving copy for the unsubscribe path: an HTML body flattened by
        // htmlToPlainText would defeat stripQuotedReply's line-anchored markers; a
        // text/plain body already carries its own newlines.
        bodyTextLined = msg.body.contentType === "html"
          ? htmlToPlainText(msg.body.content, true)
          : msg.body.content;
      }

      toRecipients = (msg.toRecipients || []).map(
        (r: { emailAddress?: { address?: string } }) =>
          r.emailAddress?.address?.toLowerCase() ?? ""
      ).filter(Boolean);
      ccRecipients = (msg.ccRecipients || []).map(
        (r: { emailAddress?: { address?: string } }) =>
          r.emailAddress?.address?.toLowerCase() ?? ""
      ).filter(Boolean);

      internetMessageHeaders = (msg.internetMessageHeaders || []).map(
        (h: { name: string; value: string }) => ({ name: h.name, value: h.value })
      );

      logger.info("mail.outlook.reply_detected", {
        mail_account_id: mailAccountId,
        provider_message_id: providerMessageId,
        sender_email: senderEmail,
        subject: messageSubject,
      });
    } else {
      const errBody = await msgResp.text();
      logger.warn("mail.outlook.webhook_fetch_message_failed", {
        status: msgResp.status,
        provider_message_id: providerMessageId,
        error: errBody,
      });
    }
  } catch (fetchErr) {
    logger.error("mail.outlook.webhook_token_error", {
      mail_account_id: mailAccountId,
      error: String(fetchErr),
    });
  }

  // The message's real arrival time (falls back to now() only if Graph did not
  // give us one — e.g. the message fetch above failed).
  const occurredAt = receivedAt ?? new Date().toISOString();

  // --- 5. Record in idempotency log ---
  //
  // This insert IS the claim on this notification, and it runs BEFORE any side
  // effect below. Its result used to be ignored, which meant two things went
  // wrong silently: a constraint violation left no marker (so every redelivery
  // re-ran the pauses and system notes), and any other failure did the same.
  //
  //   • Unique violation → another delivery of this same notification for this
  //     same mailbox already claimed it (concurrent redelivery). STOP: it is
  //     running the side effects, or already has. The constraint is scoped
  //     (provider, mail_account_id, provider_message_id) — see the migration —
  //     so this can no longer fire because a DIFFERENT mailbox saw the same id.
  //   • Any other error → log loudly and PROCEED. Losing an inbound reply is
  //     the guardrail failure (the automation keeps sending); a replayed pause
  //     or a duplicated system note is the lesser harm.
  const { error: claimErr } = await serviceClient.from("mail_event_log").insert({
    provider: "outlook",
    provider_message_id: providerMessageId,
    mail_account_id: mailAccountId,
    event_type: changeType,
    payload: {
      notification,
      sender_email: senderEmail,
      subject: messageSubject,
      conversation_id: conversationId,
    },
    processed_at: new Date().toISOString(),
  });
  if (claimErr) {
    const isUniqueViolation = claimErr.code === "23505" ||
      /duplicate key|unique.?constraint|23505/i.test(claimErr.message ?? "");
    if (isUniqueViolation) {
      logger.info("mail.outlook.webhook_duplicate_race_lost", {
        mail_account_id: mailAccountId,
        provider_message_id: providerMessageId,
      });
      return;
    }
    logger.error("mail.outlook.webhook_claim_failed_proceeding", {
      mail_account_id: mailAccountId,
      provider_message_id: providerMessageId,
      error: claimErr.message,
    });
  }

  if (!senderEmail) {
    logger.info("mail.outlook.webhook_no_sender", { provider_message_id: providerMessageId });
    return;
  }

  // --- 6. Bounce detection ---
  const senderLower = senderEmail.toLowerCase();
  const subjectLower = (messageSubject || "").toLowerCase();
  const isBounce =
    senderLower.includes("postmaster") ||
    senderLower.includes("mailer-daemon") ||
    senderLower.includes("mail delivery") ||
    subjectLower.includes("delivery status notification") ||
    subjectLower.includes("undeliverable") ||
    subjectLower.includes("mail delivery failed") ||
    subjectLower.includes("returned mail") ||
    subjectLower.includes("failure notice") ||
    subjectLower.includes("delivery failure");

  if (isBounce) {
    for (const recipientEmail of toRecipients) {
      // Scoped to the mailbox's workspace — see WORKSPACE ISOLATION above.
      //
      // ALL matching rows, not the oldest one. A workspace legitimately holds
      // several lead rows for one address, and a bounce says the ADDRESS is
      // undeliverable — so every row carrying it must stop, or the duplicate we
      // did not pick carries on mailing a dead mailbox. (The previous
      // `.order(created_at).limit(1)` picked one arbitrarily.)
      const { data: bounceLeads } = await serviceClient
        .from("leads")
        .select("id, name")
        .eq("email", recipientEmail)
        .eq("workspace_id", mailboxWorkspaceId)
        .limit(DUPLICATE_LEAD_SCAN_LIMIT);

      for (const row of (bounceLeads ?? []) as Array<{ id: string }>) {
        logger.info("mail.outlook.bounce_detected", {
          lead_id: row.id,
          subject: messageSubject,
          matched_rows: (bounceLeads ?? []).length,
        });

        await serviceClient.from("leads").update({
          unsubscribed: true,
          needs_action: false,
          eligible_at: null,
          next_action_key: null,
          next_action_label: null,
          action_reason_code: null,
          nurture_status: "inactive",
        }).eq("id", row.id);

        await createCanonicalInteraction(serviceClient, {
          lead_id: row.id,
          type: "system_note",
          source: "automation",
          body_text: `Email bounced/undeliverable (subject: "${messageSubject}") — automation stopped permanently. Please verify the email address.`,
          occurred_at: new Date().toISOString(),
          provider: "automation",
        });
      }
    }
    return;
  }

  // --- 7. Identify lead by sender email ---
  // Scoped to the mailbox's workspace — see WORKSPACE ISOLATION above.
  //
  // ALL matching rows. A workspace legitimately holds more than one lead row
  // for an address, and this used to resolve that with
  // `.order("created_at").limit(1)` — the OLDEST row. That is close to the
  // worst available answer: the row carrying the live campaign is usually the
  // NEWER one, so the reply AND the instant-pause that rides with it both
  // landed on a dormant duplicate, while the active row carried on emailing
  // someone who had just written back. Instant-pause-on-inbound is a guardrail;
  // it was being routed to the wrong row.
  //
  // Now: attribution goes to the most-live row (`pickPrimaryLead`), and the
  // guardrails below are applied to EVERY matching row. See
  // `_shared/leadResolution.ts` for the ordering and its reasoning.
  const { data: leadMatches } = await serviceClient
    .from("leads")
    .select("id, name, owner_user_id, email, stage, ooo_until, unsubscribed, workspace_id, automation_mode, nurture_status, last_activity_at, created_at")
    .eq("email", senderEmail)
    .eq("workspace_id", mailboxWorkspaceId)
    .limit(DUPLICATE_LEAD_SCAN_LIMIT);

  type LeadMatch = {
    id: string;
    name: string;
    owner_user_id: string | null;
    email: string;
    stage: string;
    ooo_until: string | null;
    unsubscribed: boolean;
    workspace_id: string | null;
    automation_mode: string | null;
    nurture_status: string | null;
    last_activity_at: string | null;
    created_at: string | null;
  };

  const matches = (leadMatches ?? []) as LeadMatch[];
  const leadRow = pickPrimaryLead(matches);

  if (!leadRow) {
    logger.info("mail.outlook.webhook_no_lead_match", {
      sender_email: senderEmail,
      workspace_id: mailboxWorkspaceId,
    });
    return;
  }

  if (matches.length > 1) {
    logger.info("mail.outlook.webhook_duplicate_leads", {
      sender_email: senderEmail,
      workspace_id: mailboxWorkspaceId,
      matched_rows: matches.length,
      attributed_to: leadRow.id,
      armed_rows: matches.filter((m) => m.automation_mode).length,
    });
  }

  // --- 8. Direct conversation filter ---
  if (repEmail && !toRecipients.includes(repEmail)) {
    logger.info("mail.outlook.webhook_not_direct_conversation", {
      sender_email: senderEmail,
      to_recipients: toRecipients,
      rep_email: repEmail,
    });
    return;
  }

  // Set when applyOOOPause paused the lead but deliberately KEPT it
  // actionable (auto-reply carrying a live commercial question). The
  // defer branch below must not then clear needs_action again.
  let oooKeptActionable = false;
  // --- 9. OOO detection ---
  {
    const oooResult = isOutOfOfficeReply(internetMessageHeaders, messageSubject || "", bodyText);
    const oooPause = await applyOOOPause({
      supabase: serviceClient,
      leadId: leadRow.id,
      workspaceId: leadRow.workspace_id ?? null,
      leadName: leadRow.name,
      oooResult,
      occurredAt,
      logPrefix: "[outlook-webhook]",
    });
    // Pause the automation whenever an OOO landed, but only RETURN (i.e.
    // drop the message) for a routine auto-reply. An OOO carrying a live
    // commercial question is paused AND kept actionable, so it must fall
    // through and be stored (Codex P1, PR #143).
    if (oooPause.paused) {
      // clearLeadAction=false when we kept the lead actionable — pausing the
      // automation must not blank the reply_now applyOOOPause just wrote.
      //
      // EVERY matching row, for the same reason as the reply pause below: the
      // contact is away, so no duplicate of theirs should keep sending.
      for (const m of matches) {
        await pauseActiveAutomation(
          serviceClient,
          m.id,
          mailAccountId,
          "ooo_reply",
          oooPause.skipInbound,
        );
      }
      if (oooPause.skipInbound) return;
      oooKeptActionable = true;
    }
  }

  // ── Defer / "reconnect later" detection ──
  // Skipped when the OOO above deliberately kept this lead actionable —
  // applyDeferPause clears needs_action, which would immediately undo it.
  if (!oooKeptActionable) {
    const deferResult = detectDeferSignal(bodyText, new Date());
    await applyDeferPause({
      supabase: serviceClient,
      leadId: leadRow.id,
      workspaceId: leadRow.workspace_id ?? null,
      deferResult,
      logPrefix: "[outlook-webhook]",
    });
  }

  // --- 9b. Meeting confirmation detection ---
  {
    const meetingResult = detectMeetingConfirmation(messageSubject || "", bodyText);
    if (meetingResult.isConfirmed) {
      // Body-aware override (EDGE_CASES #4): when a calendar-accept also
      // carries a substantive commercial question, keep needs_action open.
      const override = meetingResult.hasSubstantiveQuestion;
      logger.info("mail.outlook.meeting_confirmed", {
        lead_id: leadRow.id,
        confidence: meetingResult.confidence,
        matched: meetingResult.matchedText,
        substantive_question: override,
        matched_keywords: meetingResult.matchedKeywords,
      });

      const leadUpdate: Record<string, unknown> = { has_future_meeting: true };
      if (!override) leadUpdate.needs_action = false;
      await serviceClient.from("leads").update(leadUpdate).eq("id", leadRow.id);

      const noteBody = override
        ? `📅 Meeting confirmed — "${meetingResult.matchedText}". Reply still needed — substantive question detected (matched: ${meetingResult.matchedKeywords.join(", ")}).`
        : `📅 Meeting confirmed — "${meetingResult.matchedText}". No reply needed.`;
      await createCanonicalInteraction(serviceClient, {
        lead_id: leadRow.id,
        type: "system_note",
        source: "automation",
        body_text: noteBody,
        occurred_at: new Date().toISOString(),
        workspace_id: leadRow.workspace_id ?? null,
        provider: "automation",
      });
    }
  }

  // --- 10. Newsletter guard + Unsubscribe detection ---
  const hasListUnsubscribeHeader = internetMessageHeaders.some(
    h => h.name.toLowerCase() === "list-unsubscribe"
  );

  if (!hasListUnsubscribeHeader && !leadRow.unsubscribed) {
    // Strip quoted thread history first so our own quoted pitch can't self-trigger an opt-out.
    // Use the newline-preserving body — stripQuotedReply's markers are line-anchored, so the
    // flattened bodyText would strip nothing and let a quoted pitch re-trigger a false opt-out.
    const bodyLower = stripQuotedReply(bodyTextLined).toLowerCase();
    if (isHumanUnsubscribeRequest(bodyLower)) {
      logger.info("mail.outlook.unsubscribe_detected", { lead_id: leadRow.id });

      // EVERY matching row: the human said stop emailing me, so every lead row
      // carrying this address must stop — not just the one we attributed the
      // message to.
      await serviceClient.from("leads").update({
        unsubscribed: true,
        needs_action: false,
        eligible_at: null,
        next_action_key: null,
        next_action_label: null,
        action_reason_code: null,
        nurture_status: "inactive",
      }).in("id", matches.map((m) => m.id));

      await createCanonicalInteraction(serviceClient, {
        lead_id: leadRow.id,
        type: "system_note",
        source: "automation",
        body_text: "Lead requested to unsubscribe — automation stopped permanently.",
        occurred_at: new Date().toISOString(),
        workspace_id: leadRow.workspace_id ?? null,
        provider: "automation",
      });
    }
  }

  // --- 11. Create interaction record + timeline projection ---
  await createCanonicalInteraction(serviceClient, {
    lead_id: leadRow.id,
    type: "email_inbound",
    source: "outlook",
    body_text: bodyText.substring(0, 10000),
    // The message's real arrival time, not our processing time.
    occurred_at: occurredAt,
    direction: "inbound",
    subject: messageSubject,
    from_email: senderEmail,
    to_email: repEmail,
    to_emails: toRecipients,
    cc_emails: ccRecipients,
    workspace_id: leadRow.workspace_id ?? null,
    provider: "outlook",
    metadata_json: {
      provider_message_id: providerMessageId,
      conversation_id: conversationId,
      // Decided against the FULL body; classify-inbound only sees the
      // 500-char snippet (Codex P1, PR #143). This path is always inbound.
      [SUBSTANTIVE_QUESTION_FLAG]: hasSubstantiveQuestion(bodyText),
    },
    // ONE key for both Outlook paths, SCOPED TO THE LEAD. The webhook used to
    // write `outlook:webhook:<graphId>` while outlook-sync wrote
    // `outlook:<internetMessageId>` — two keys for one message, so a lead whose
    // mail arrived by webhook and was later re-synced got it stored twice.
    // Unifying them on the RFC 2822 Message-ID then exposed the opposite
    // problem: that id is GLOBAL, so two tenants receiving the same message
    // collided on `interactions`' global unique index and the second workspace
    // resolved to the first's interaction row. See `_shared/dedupeKeys.ts`.
    dedupe_key: outlookEmailDedupeKey(leadRow.id, internetMessageId, providerMessageId, providerMessageId),
  });

  // --- 12. Update lead state ---
  //
  // MONOTONIC RECENCY, ENFORCED BY THE DATABASE.
  //
  // `occurred_at` on the timeline row is the message's real received time —
  // that is what makes the timeline order right. But these two LEAD columns
  // mean "how recently did something happen", and they must never move
  // backwards, because `last_inbound_at` is what `syncEngine.buildLeadUpdate`
  // compares against `action_dismissed_at` to decide whether to resurface a
  // lead. A rewind silently un-resurfaces a lead a rep has handled, or re-arms
  // a cadence against someone who just wrote in.
  //
  // Two ways they can go backwards:
  //   1. Graph fires a change notification when a message is MOVED INTO the
  //      watched folder, not only when it arrives — rescuing an old mail out of
  //      Junk delivers a genuinely old receivedDateTime today.
  //   2. Graph delivers notifications in PARALLEL. Two arriving close together
  //      is ordinary, not exotic.
  //
  // Computing `max(current, new)` in TypeScript closes (1) and leaves (2) wide
  // open: it is a read-modify-write over a snapshot taken before this function
  // started, so the older request can finish last and clobber the newer one.
  // So the comparison happens in Postgres instead, as the UPDATE's own WHERE
  // clause — an advance-only write. Under READ COMMITTED a second UPDATE on the
  // same row blocks on the first, then RE-EVALUATES this predicate against the
  // committed row, so the loser simply matches nothing and writes nothing.
  //
  // `IS NULL OR <` rather than `GREATEST(col, $new)`: PostgREST update payloads
  // carry literal values, so a column reference cannot be expressed there.
  // (For the record, Postgres' GREATEST ignores NULL arguments rather than
  // propagating them — verified, it is not the SQL-standard behaviour — so the
  // NULL case would have been safe either way. Here it is explicit: a lead's
  // FIRST inbound has last_inbound_at IS NULL, and that branch is what sets it.)
  //
  // Separate statements per column on purpose: a lead can have a newer
  // `last_activity_at` (a later outbound) than `last_inbound_at`, so one shared
  // guard would let an inbound drag activity backwards.
  // `occurredAt` always comes from `Date.toISOString()`, which yields a
  // `…T…Z` form containing none of PostgREST's reserved filter characters
  // (no comma, parenthesis, or `+` offset), so it is safe to interpolate into
  // the filter unquoted. Keep it that way: a `+01:00`-style offset would be
  // read as a space in the query string and the filter would silently match
  // nothing — which here means the timestamps quietly stop advancing.
  const advanceOnly = (column: string) =>
    serviceClient
      .from("leads")
      .update({ [column]: occurredAt })
      .eq("id", leadRow.id)
      .or(`${column}.is.null,${column}.lt.${occurredAt}`);

  await advanceOnly("last_inbound_at");
  await advanceOnly("last_activity_at");

  // Stage is a forward-only ladder already gated on its current value, so it
  // stays an unconditional write.
  if (leadRow.stage === "new" || leadRow.stage === "contacted") {
    await serviceClient
      .from("leads")
      .update({ stage: "engaged" })
      .eq("id", leadRow.id);
  }

  // --- 13. Pause active automation ---
  //
  // EVERY matching row, not just the attributed one. This is the
  // instant-pause-on-inbound guardrail, and it is the reason the tiebreak above
  // is no longer safety-critical: whichever duplicate we attribute the reply to,
  // every row carrying this address stops sending. Pausing a dormant duplicate
  // costs nothing; missing an armed one emails a customer who just wrote back.
  // (Production has a duplicate group with SEVERAL armed rows, so "pause the one
  // we picked" would genuinely have left a sender running.)
  for (const m of matches) {
    await pauseActiveAutomation(serviceClient, m.id, mailAccountId, "reply_received");
  }

  logger.info("mail.outlook.inbound_processed", {
    lead_id: leadRow.id,
    lead_name: leadRow.name,
    sender_email: senderEmail,
  });
}

// ============================================================
// Helper: Pause active automation_log entries
// ============================================================
/**
 * Pause the lead's active automation_log row.
 *
 * `clearLeadAction` (default true) also blanks the lead's human reply
 * prompt (needs_action / next_action_key / next_action_label). That is
 * right for a routine auto-reply, and WRONG for an OOO that carries a
 * live commercial question: applyOOOPause has just deliberately set
 * `reply_now`, and clearing it here undid that one line later — the
 * message was stored (previous fix worked) but never became actionable.
 * Callers in that case pass `clearLeadAction: false`: we still pause the
 * robot, we just don't take the question off the rep's board.
 * (Codex P1 on PR #143.)
 */
async function pauseActiveAutomation(
  serviceClient: ReturnType<typeof createClient>,
  leadId: string,
  mailAccountId: string,
  reason: string,
  clearLeadAction = true,
): Promise<void> {
  const { data: activeLog, error: logErr } = await serviceClient
    .from("automation_log")
    .select("id, status, action_key")
    .eq("lead_id", leadId)
    .eq("mail_account_id", mailAccountId)
    .in("status", ["pending", "sent"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (logErr) {
    logger.error("mail.outlook.webhook_log_query_failed", {
      lead_id: leadId,
      error: logErr.message,
    });
    return;
  }

  if (!activeLog) {
    const { data: legacyLog } = await serviceClient
      .from("automation_log")
      .select("id, status, action_key")
      .eq("lead_id", leadId)
      .in("status", ["pending", "sent"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (legacyLog) {
      const row = legacyLog as { id: string; action_key: string };
      await serviceClient
        .from("automation_log")
        .update({
          status: "paused",
          error_message: reason,
          completed_at: new Date().toISOString(),
        })
        .eq("id", row.id);

      logger.info("mail.outlook.automation_paused", {
        lead_id: leadId,
        automation_log_id: row.id,
        reason,
      });
    }
    return;
  }

  const row = activeLog as { id: string; action_key: string };
  await serviceClient
    .from("automation_log")
    .update({
      status: "paused",
      error_message: reason,
      completed_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  if (clearLeadAction) {
    await serviceClient
      .from("leads")
      .update({
        needs_action: false,
        next_action_key: null,
        next_action_label: null,
      })
      .eq("id", leadId);
  }

  logger.info("mail.outlook.automation_paused", {
    lead_id: leadId,
    automation_log_id: row.id,
    action_key: row.action_key,
    reason,
  });
}
