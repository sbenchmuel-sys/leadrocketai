// ============================================================
// outlook-webhook — Graph change notification receiver
//
// Hardening guarantees (Phase 2):
//   1. Always returns 200 to Graph — never crashes
//   2. Idempotency via mail_event_log
//   3. clientState validation
//
// Phase 3 additions:
//   4. Fetches full message from Graph API
//   5. Identifies lead by sender email
//   6. Pauses matching active automation_log entry
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getFreshOutlookToken } from "../_shared/outlookTokens.ts";
import { logger } from "../_shared/logger.ts";

serve(async (req) => {
  // Graph validation handshake during subscription creation
  if (req.method === "GET") {
    const validationToken = new URL(req.url).searchParams.get("validationToken");
    if (validationToken) {
      return new Response(validationToken, { headers: { "Content-Type": "text/plain" } });
    }
    return new Response("OK", { status: 200 });
  }

  // Always 200 to Graph — errors must never surface as HTTP failures
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    let body: { value?: Array<Record<string, unknown>> };
    try {
      body = await req.json();
    } catch {
      logger.warn("mail.outlook.webhook_invalid_body", {});
      return new Response("OK", { status: 200 });
    }

    const notifications = body.value ?? [];

    for (const notification of notifications) {
      // Fire-and-forget per notification so one failure doesn't block others
      processNotification(notification, serviceClient).catch((err) => {
        logger.error("mail.outlook.webhook_process_error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    logger.error("mail.outlook.webhook_fatal", { error: String(err) });
    return new Response("OK", { status: 200 });
  }
});

// ============================================================
// Core notification processor
// ============================================================
async function processNotification(
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

  // Validate clientState to prevent spoofed notifications
  if (sub.client_state && notifClientState !== sub.client_state) {
    logger.warn("mail.outlook.webhook_invalid_client_state", {
      subscription_id: subscriptionId,
      expected: sub.client_state,
      received: notifClientState,
    });
    return;
  }

  const mailAccountId: string = sub.mail_account_id;

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

  // --- 3. Fetch full message from Graph ---
  let senderEmail: string | null = null;
  let messageSubject: string | null = null;
  let conversationId: string | null = null;

  try {
    const accessToken = await getFreshOutlookToken(mailAccountId, serviceClient);
    const msgResp = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${providerMessageId}?$select=id,subject,from,conversationId,receivedDateTime,internetMessageId`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (msgResp.ok) {
      const msg = await msgResp.json();
      senderEmail = msg.from?.emailAddress?.address?.toLowerCase() ?? null;
      messageSubject = msg.subject ?? null;
      conversationId = msg.conversationId ?? null;

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
    // Still record idempotency entry and proceed
  }

  // --- 4. Record in idempotency log ---
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

  // --- 5. Identify lead by sender email and pause active automation ---
  if (!senderEmail) {
    logger.info("mail.outlook.webhook_no_sender", { provider_message_id: providerMessageId });
    return;
  }

  const { data: lead } = await serviceClient
    .from("leads")
    .select("id, name, owner_user_id")
    .eq("email", senderEmail)
    .maybeSingle();

  if (!lead) {
    logger.info("mail.outlook.webhook_no_lead_match", { sender_email: senderEmail });
    return;
  }

  // --- 6. Pause active automation_log entries for this lead + account ---
  // automation_log.status tracks automation state:
  //   "pending" = scheduled but not yet sent
  //   "sent"    = sent, waiting for reply
  // We pause any that are still in an active (pending/sent) state
  const { data: activeLog, error: logErr } = await serviceClient
    .from("automation_log")
    .select("id, status, action_key")
    .eq("lead_id", lead.id)
    .eq("mail_account_id", mailAccountId)
    .in("status", ["pending", "sent"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (logErr) {
    logger.error("mail.outlook.webhook_log_query_failed", {
      lead_id: lead.id,
      error: logErr.message,
    });
    return;
  }

  if (!activeLog) {
    // No active automation — still a valid reply, just nothing to pause
    logger.info("mail.outlook.webhook_no_active_automation", {
      lead_id: lead.id,
      sender_email: senderEmail,
    });
    return;
  }

  // Pause: mark the log entry as paused with reason
  await serviceClient
    .from("automation_log")
    .update({
      status: "paused",
      error_message: "reply_received",
      completed_at: new Date().toISOString(),
    })
    .eq("id", activeLog.id);

  // Also update the lead itself to clear needs_action automation flags
  await serviceClient
    .from("leads")
    .update({
      needs_action: false,
      next_action_key: null,
      next_action_label: null,
      last_inbound_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
    })
    .eq("id", lead.id);

  logger.info("mail.outlook.automation_paused", {
    lead_id: lead.id,
    lead_name: lead.name,
    sender_email: senderEmail,
    automation_log_id: activeLog.id,
    action_key: activeLog.action_key,
    pause_reason: "reply_received",
  });
}
