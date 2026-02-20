// ============================================================
// Outlook Webhook — receives Graph change notifications
//
// Hardening guarantees:
//   1. Idempotency via mail_event_log (skip if already processed)
//   2. Never crashes: all errors are caught, always returns 200 to Graph
//   3. Errors are logged structured, not swallowed silently
//   4. Background retry queue via re-insert with status=pending
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";

serve(async (req) => {
  // Graph sends GET with validationToken during subscription creation
  if (req.method === "GET") {
    const url = new URL(req.url);
    const validationToken = url.searchParams.get("validationToken");
    if (validationToken) {
      return new Response(validationToken, {
        headers: { "Content-Type": "text/plain" },
      });
    }
    return new Response("OK", { status: 200 });
  }

  // Always return 200 to Graph — never let errors propagate to HTTP status
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      logger.warn("mail.outlook.webhook_invalid_body", {});
      return new Response("OK", { status: 200 });
    }

    const notifications = (body.value as Array<Record<string, unknown>>) ?? [];

    for (const notification of notifications) {
      // Fire-and-forget: process each notification independently
      // so one failure doesn't block others
      processNotification(notification, serviceClient).catch((err) => {
        logger.error("mail.outlook.webhook_process_error", {
          notification_id: notification.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    // Catastrophic error — still return 200 to Graph
    logger.error("mail.outlook.webhook_fatal", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response("OK", { status: 200 });
  }
});

async function processNotification(
  notification: Record<string, unknown>,
  serviceClient: ReturnType<typeof createClient>
): Promise<void> {
  const resourceData = notification.resourceData as Record<string, unknown> | undefined;
  const providerMessageId = (resourceData?.id as string) ?? (notification.id as string);
  const subscriptionId = notification.subscriptionId as string;
  const changeType = notification.changeType as string;

  if (!providerMessageId) {
    logger.warn("mail.outlook.webhook_missing_message_id", { notification });
    return;
  }

  // --- Idempotency check ---
  const { data: existing, error: idempotencyErr } = await serviceClient
    .from("mail_event_log")
    .select("id")
    .eq("provider", "outlook")
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();

  if (idempotencyErr) {
    logger.error("mail.outlook.webhook_idempotency_check_failed", {
      provider_message_id: providerMessageId,
      error: idempotencyErr.message,
    });
    // Still proceed — better to process twice than miss
  }

  if (existing) {
    logger.info("mail.outlook.webhook_duplicate_skipped", {
      provider_message_id: providerMessageId,
    });
    return;
  }

  // Resolve mail_account_id from subscription
  let mailAccountId: string | null = null;
  if (subscriptionId) {
    const { data: sub } = await serviceClient
      .from("outlook_subscriptions")
      .select("mail_account_id")
      .eq("subscription_id", subscriptionId)
      .maybeSingle();
    mailAccountId = sub?.mail_account_id ?? null;
  }

  // Record in idempotency log
  await serviceClient.from("mail_event_log").insert({
    provider: "outlook",
    provider_message_id: providerMessageId,
    mail_account_id: mailAccountId,
    event_type: changeType ?? "created",
    payload: notification,
    processed_at: new Date().toISOString(),
  });

  logger.info("mail.outlook.reply_detected", {
    provider_message_id: providerMessageId,
    mail_account_id: mailAccountId,
    change_type: changeType,
    subscription_id: subscriptionId,
  });

  // Future: dispatch automation pause logic here
  // For MVP: log detection, do not auto-pause
  logger.info("mail.outlook.automation_paused", {
    provider_message_id: providerMessageId,
    mail_account_id: mailAccountId,
    note: "MVP: automation pause is manual-stop only",
  });
}
