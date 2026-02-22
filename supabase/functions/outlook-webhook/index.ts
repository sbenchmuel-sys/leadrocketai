// ============================================================
// outlook-webhook — Graph change notification receiver
//
// Safeguards (parity with gmail-sync):
//   1. Always returns 200 to Graph — never crashes
//   2. Idempotency via mail_event_log
//   3. clientState validation
//   4. Direct conversation filter (skip newsletters/notifications)
//   5. Bounce detection (postmaster/mailer-daemon)
//   6. OOO detection with return date parsing
//   7. Newsletter guard (List-Unsubscribe header)
//   8. Unsubscribe detection (human opt-out phrases only)
//   9. Interaction recording
//  10. Lead state updates (last_inbound_at, stage)
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getFreshOutlookToken } from "../_shared/outlookTokens.ts";
import { logger } from "../_shared/logger.ts";
import { isOutOfOfficeReply, getOOOEligibleAt } from "../_shared/oooDetection.ts";

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

  // --- 3. Get mail account email (needed for direct conversation filter) ---
  const { data: mailAccount } = await serviceClient
    .from("mail_accounts")
    .select("email_address")
    .eq("id", mailAccountId)
    .single();

  const repEmail = mailAccount?.email_address?.toLowerCase().trim() || "";

  // --- 4. Fetch full message from Graph (with headers + body for safeguards) ---
  let senderEmail: string | null = null;
  let messageSubject: string | null = null;
  let conversationId: string | null = null;
  let bodyText = "";
  let toRecipients: string[] = [];
  let internetMessageHeaders: Array<{ name: string; value: string }> = [];

  try {
    const accessToken = await getFreshOutlookToken(mailAccountId, serviceClient);
    const msgResp = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${providerMessageId}?$select=id,subject,from,toRecipients,conversationId,receivedDateTime,internetMessageId,body,internetMessageHeaders`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (msgResp.ok) {
      const msg = await msgResp.json();
      senderEmail = msg.from?.emailAddress?.address?.toLowerCase() ?? null;
      messageSubject = msg.subject ?? null;
      conversationId = msg.conversationId ?? null;

      // Extract body as plain text
      if (msg.body?.content) {
        bodyText = msg.body.contentType === "html"
          ? htmlToPlainText(msg.body.content)
          : msg.body.content;
      }

      // Extract to recipients
      toRecipients = (msg.toRecipients || []).map(
        (r: { emailAddress?: { address?: string } }) =>
          r.emailAddress?.address?.toLowerCase() ?? ""
      ).filter(Boolean);

      // Extract internet message headers
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
    // Find any lead associated with this bounce (check To recipients)
    for (const recipientEmail of toRecipients) {
      const { data: bounceLead } = await serviceClient
        .from("leads")
        .select("id, name")
        .eq("email", recipientEmail)
        .maybeSingle();

      if (bounceLead) {
        logger.info("mail.outlook.bounce_detected", {
          lead_id: bounceLead.id,
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
        }).eq("id", bounceLead.id);

        await serviceClient.from("interactions").insert({
          lead_id: bounceLead.id,
          type: "system_note",
          source: "automation",
          body_text: `Email bounced/undeliverable (subject: "${messageSubject}") — automation stopped permanently. Please verify the email address.`,
          occurred_at: new Date().toISOString(),
        });
      }
    }
    return; // Bounces are not real inbound — stop processing
  }

  // --- 7. Identify lead by sender email ---
  const { data: lead } = await serviceClient
    .from("leads")
    .select("id, name, owner_user_id, email, stage, ooo_until, unsubscribed")
    .eq("email", senderEmail)
    .maybeSingle();

  if (!lead) {
    logger.info("mail.outlook.webhook_no_lead_match", { sender_email: senderEmail });
    return;
  }

  // --- 8. Direct conversation filter ---
  // Only process emails that are directly TO the rep's connected address.
  // Skip newsletters/notifications that happen to be FROM the lead's domain.
  if (repEmail && !toRecipients.includes(repEmail)) {
    logger.info("mail.outlook.webhook_not_direct_conversation", {
      sender_email: senderEmail,
      to_recipients: toRecipients,
      rep_email: repEmail,
    });
    return;
  }

  // --- 9. OOO detection ---
  const oooResult = isOutOfOfficeReply(internetMessageHeaders, messageSubject || "", bodyText);
  if (oooResult.isOOO) {
    const eligibleAt = getOOOEligibleAt(oooResult.returnDate);
    const returnDateStr = oooResult.returnDate
      ? oooResult.returnDate.toLocaleDateString("en-US", { month: "long", day: "numeric" })
      : "approximately 7 days";

    logger.info("mail.outlook.ooo_detected", {
      lead_id: lead.id,
      confidence: oooResult.confidence,
      return_date: returnDateStr,
    });

    await serviceClient.from("leads").update({
      ooo_until: oooResult.returnDate ? oooResult.returnDate.toISOString() : eligibleAt,
      eligible_at: eligibleAt,
      needs_action: false,
      next_action_key: null,
      next_action_label: null,
      action_reason_code: null,
    }).eq("id", lead.id);

    await serviceClient.from("interactions").insert({
      lead_id: lead.id,
      type: "system_note",
      source: "automation",
      body_text: `📵 OOO auto-reply detected (${oooResult.confidence} signal). ${lead.name} is out of office — returning ${returnDateStr}. Automation paused until then.`,
      occurred_at: new Date().toISOString(),
    });

    // Pause any active automation
    await pauseActiveAutomation(serviceClient, lead.id, mailAccountId, "ooo_reply");
    return; // OOO replies are not real inbound
  }

  // --- 10. Newsletter guard + Unsubscribe detection ---
  const hasListUnsubscribeHeader = internetMessageHeaders.some(
    h => h.name.toLowerCase() === "list-unsubscribe"
  );

  if (!hasListUnsubscribeHeader && !lead.unsubscribed) {
    const bodyLower = bodyText.toLowerCase();
    if (
      /\bstop\s+emailing\b/.test(bodyLower) ||
      /\bremove\s+me\b/.test(bodyLower) ||
      /\bplease\s+(don['']t|do\s+not|stop)\s+(email|contact|reach)\b/.test(bodyLower)
    ) {
      logger.info("mail.outlook.unsubscribe_detected", { lead_id: lead.id });

      await serviceClient.from("leads").update({
        unsubscribed: true,
        needs_action: false,
        eligible_at: null,
        next_action_key: null,
        next_action_label: null,
        action_reason_code: null,
        nurture_status: "inactive",
      }).eq("id", lead.id);

      await serviceClient.from("interactions").insert({
        lead_id: lead.id,
        type: "system_note",
        source: "automation",
        body_text: "Lead requested to unsubscribe — automation stopped permanently.",
        occurred_at: new Date().toISOString(),
      });
    }
  }

  // --- 11. Create interaction record ---
  await serviceClient.from("interactions").insert({
    lead_id: lead.id,
    type: "email_inbound",
    source: "outlook",
    occurred_at: new Date().toISOString(),
    subject: messageSubject,
    from_email: senderEmail,
    to_email: repEmail,
    body_text: bodyText.substring(0, 10000),
    direction: "inbound",
  });

  // --- 12. Update lead state ---
  await serviceClient
    .from("leads")
    .update({
      last_inbound_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      // Basic stage progression: if new → engaged (they replied)
      ...(lead.stage === "new" || lead.stage === "contacted" ? { stage: "engaged" } : {}),
    })
    .eq("id", lead.id);

  // --- 13. Pause active automation ---
  await pauseActiveAutomation(serviceClient, lead.id, mailAccountId, "reply_received");

  logger.info("mail.outlook.inbound_processed", {
    lead_id: lead.id,
    lead_name: lead.name,
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
    // Also check without mail_account_id filter (legacy entries)
    const { data: legacyLog } = await serviceClient
      .from("automation_log")
      .select("id, status, action_key")
      .eq("lead_id", leadId)
      .in("status", ["pending", "sent"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (legacyLog) {
      await serviceClient
        .from("automation_log")
        .update({
          status: "paused",
          error_message: reason,
          completed_at: new Date().toISOString(),
        })
        .eq("id", legacyLog.id);

      logger.info("mail.outlook.automation_paused", {
        lead_id: leadId,
        automation_log_id: legacyLog.id,
        reason,
      });
    }
    return;
  }

  await serviceClient
    .from("automation_log")
    .update({
      status: "paused",
      error_message: reason,
      completed_at: new Date().toISOString(),
    })
    .eq("id", activeLog.id);

  // Clear lead automation flags
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
    automation_log_id: activeLog.id,
    action_key: activeLog.action_key,
    reason,
  });
}
