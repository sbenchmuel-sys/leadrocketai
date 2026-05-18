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
import { detectMeetingConfirmation } from "../_shared/meetingConfirmation.ts";
import { isHumanUnsubscribeRequest } from "../_shared/unsubscribeDetection.ts";
import { createCanonicalInteraction } from "../_shared/canonicalInteraction.ts";
import {
  renewOutlookSubscription,
  SUBSCRIPTION_LIFETIME_MS,
} from "../_shared/outlookSubscription.ts";

// Strip HTML tags for plain-text body_text
function htmlToPlainText(html: string): string {
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
  text = text.replace(/\s+/g, " ");
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
    .select("id, mail_account_id, client_state, status")
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
  const { data: existing } = await serviceClient
    .from("mail_event_log")
    .select("id")
    .eq("provider", "outlook")
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();

  if (existing) {
    logger.info("mail.outlook.webhook_duplicate_skipped", { provider_message_id: providerMessageId });
    return;
  }

  // --- 3. Get mail account email (needed for direct conversation filter) ---
  const { data: mailAccount } = await serviceClient
    .from("mail_accounts")
    .select("email_address")
    .eq("id", mailAccountId)
    .single();

  const repEmail = (mailAccount as { email_address?: string } | null)?.email_address?.toLowerCase().trim() || "";

  // --- 4. Fetch full message from Graph (with headers + body for safeguards) ---
  let senderEmail: string | null = null;
  let messageSubject: string | null = null;
  let conversationId: string | null = null;
  let bodyText = "";
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

      if (msg.body?.content) {
        bodyText = msg.body.contentType === "html"
          ? htmlToPlainText(msg.body.content)
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

  // --- 5. Record in idempotency log ---
  await serviceClient.from("mail_event_log").insert({
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
      const { data: bounceLead } = await serviceClient
        .from("leads")
        .select("id, name")
        .eq("email", recipientEmail)
        .maybeSingle();

      if (bounceLead) {
        logger.info("mail.outlook.bounce_detected", {
          lead_id: (bounceLead as { id: string }).id,
          subject: messageSubject,
        });

        await serviceClient.from("leads").update({
          unsubscribed: true,
          needs_action: false,
          eligible_at: null,
          next_action_key: null,
          next_action_label: null,
          action_reason_code: null,
          nurture_status: "inactive",
        }).eq("id", (bounceLead as { id: string }).id);

        await createCanonicalInteraction(serviceClient, {
          lead_id: (bounceLead as { id: string }).id,
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
  const { data: lead } = await serviceClient
    .from("leads")
    .select("id, name, owner_user_id, email, stage, ooo_until, unsubscribed, workspace_id")
    .eq("email", senderEmail)
    .maybeSingle();

  if (!lead) {
    logger.info("mail.outlook.webhook_no_lead_match", { sender_email: senderEmail });
    return;
  }

  const leadRow = lead as {
    id: string;
    name: string;
    owner_user_id: string | null;
    email: string;
    stage: string;
    ooo_until: string | null;
    unsubscribed: boolean;
    workspace_id: string | null;
  };

  // --- 8. Direct conversation filter ---
  if (repEmail && !toRecipients.includes(repEmail)) {
    logger.info("mail.outlook.webhook_not_direct_conversation", {
      sender_email: senderEmail,
      to_recipients: toRecipients,
      rep_email: repEmail,
    });
    return;
  }

  // --- 9. OOO detection ---
  {
    const oooResult = isOutOfOfficeReply(internetMessageHeaders, messageSubject || "", bodyText);
    const applied = await applyOOOPause({
      supabase: serviceClient,
      leadId: leadRow.id,
      workspaceId: leadRow.workspace_id ?? null,
      leadName: leadRow.name,
      oooResult,
      occurredAt: new Date().toISOString(),
      logPrefix: "[outlook-webhook]",
    });
    if (applied) {
      await pauseActiveAutomation(serviceClient, leadRow.id, mailAccountId, "ooo_reply");
      return;
    }
  }

  // ── Defer / "reconnect later" detection ──
  {
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
      logger.info("mail.outlook.meeting_confirmed", {
        lead_id: leadRow.id,
        confidence: meetingResult.confidence,
        matched: meetingResult.matchedText,
      });

      await serviceClient.from("leads").update({
        has_future_meeting: true,
        needs_action: false,
      }).eq("id", leadRow.id);

      await createCanonicalInteraction(serviceClient, {
        lead_id: leadRow.id,
        type: "system_note",
        source: "automation",
        body_text: `📅 Meeting confirmed — "${meetingResult.matchedText}". No reply needed.`,
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
    const bodyLower = bodyText.toLowerCase();
    if (isHumanUnsubscribeRequest(bodyLower)) {
      logger.info("mail.outlook.unsubscribe_detected", { lead_id: leadRow.id });

      await serviceClient.from("leads").update({
        unsubscribed: true,
        needs_action: false,
        eligible_at: null,
        next_action_key: null,
        next_action_label: null,
        action_reason_code: null,
        nurture_status: "inactive",
      }).eq("id", leadRow.id);

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
    occurred_at: new Date().toISOString(),
    direction: "inbound",
    subject: messageSubject,
    from_email: senderEmail,
    to_email: repEmail,
    to_emails: toRecipients,
    cc_emails: ccRecipients,
    workspace_id: leadRow.workspace_id ?? null,
    provider: "outlook",
    metadata_json: { provider_message_id: providerMessageId, conversation_id: conversationId },
    dedupe_key: `outlook:webhook:${providerMessageId}`,
  });

  // --- 12. Update lead state ---
  await serviceClient
    .from("leads")
    .update({
      last_inbound_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      ...(leadRow.stage === "new" || leadRow.stage === "contacted" ? { stage: "engaged" } : {}),
    })
    .eq("id", leadRow.id);

  // --- 13. Pause active automation ---
  await pauseActiveAutomation(serviceClient, leadRow.id, mailAccountId, "reply_received");

  logger.info("mail.outlook.inbound_processed", {
    lead_id: leadRow.id,
    lead_name: leadRow.name,
    sender_email: senderEmail,
  });
}

// ============================================================
// Helper: Pause active automation_log entries
// ============================================================
async function pauseActiveAutomation(
  serviceClient: ReturnType<typeof createClient>,
  leadId: string,
  mailAccountId: string,
  reason: string
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

  await serviceClient
    .from("leads")
    .update({
      needs_action: false,
      next_action_key: null,
      next_action_label: null,
    })
    .eq("id", leadId);

  logger.info("mail.outlook.automation_paused", {
    lead_id: leadId,
    automation_log_id: row.id,
    action_key: row.action_key,
    reason,
  });
}
