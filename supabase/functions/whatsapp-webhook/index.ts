/**
 * WhatsApp Webhook — Slim ingestion layer
 * 
 * Responsibilities:
 * 1. GET → webhook verification (reads WHATSAPP_VERIFY_TOKEN from env)
 * 2. POST → validate signature, parse payload, write to whatsapp_event_queue
 * 
 * All business logic (lead creation, intent classification, auto-reply)
 * is handled by the whatsapp-process function via pg_cron polling.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getWhatsAppProvider,
  MetaWhatsAppProvider,
} from "../_shared/whatsappProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // ── GET → Webhook Verification ──────────────────────────
  if (req.method === "GET") {
    const url = new URL(req.url);
    const params: Record<string, string> = {};
    url.searchParams.forEach((v, k) => { params[k] = v; });

    const verifyToken = Deno.env.get("WHATSAPP_VERIFY_TOKEN") ?? "";
    if (!verifyToken) {
      console.error("[whatsapp-webhook] WHATSAPP_VERIFY_TOKEN not configured");
      return new Response("Server misconfigured", { status: 500, headers: corsHeaders });
    }

    // Use provider for verification (default to meta)
    const provider = getWhatsAppProvider("meta");
    const result = provider.verifyWebhook(params, verifyToken);

    if (result.isValid) {
      console.log("[whatsapp-webhook] Verification successful");
      return new Response(result.challenge, { status: 200, headers: corsHeaders });
    }

    console.warn("[whatsapp-webhook] Verification failed");
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  // ── POST → Ingest to Queue ──────────────────────────────

  // Read raw body for signature validation
  const rawBody = await req.text();

  // Validate webhook signature (X-Hub-Signature-256 for Meta)
  const signatureHeader = req.headers.get("X-Hub-Signature-256");
  const appSecret = Deno.env.get("WHATSAPP_APP_SECRET") ?? "";

  if (appSecret) {
    const metaProvider = getWhatsAppProvider("meta") as MetaWhatsAppProvider;
    const valid = await metaProvider.validateSignatureAsync(rawBody, signatureHeader, appSecret);
    if (!valid) {
      console.warn("[whatsapp-webhook] Invalid webhook signature — rejecting");
      return new Response("Invalid signature", { status: 403, headers: corsHeaders });
    }
  } else {
    // No app secret configured — log warning but allow (backwards compatibility)
    if (signatureHeader) {
      console.warn("[whatsapp-webhook] WHATSAPP_APP_SECRET not configured, skipping signature validation");
    }
  }

  // Parse body
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Parse webhook payload using provider
  const provider = getWhatsAppProvider("meta");
  const parsed = provider.parseWebhookPayload(body);

  if (!parsed.phoneNumberId) {
    // Possibly a status-only payload with no phone_number_id — still try to queue status events
    if (parsed.statusUpdates.length === 0 && parsed.messages.length === 0) {
      return new Response(JSON.stringify({ ok: true, queued: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // Look up integration to get workspace_id
  let workspaceId: string | null = null;
  let integrationId: string | null = null;

  if (parsed.phoneNumberId) {
    const { data: integration } = await supabase
      .from("integrations")
      .select("id, workspace_id")
      .eq("type", "whatsapp")
      .eq("provider_account_id", parsed.phoneNumberId)
      .eq("is_active", true)
      .maybeSingle();

    if (integration) {
      workspaceId = integration.workspace_id;
      integrationId = integration.id;
    } else {
      console.warn("[whatsapp-webhook] No active integration for phone_number_id:", parsed.phoneNumberId);
    }
  }

  if (!workspaceId || !integrationId) {
    // Can't route this event — return 200 to Meta so it doesn't retry
    return new Response(JSON.stringify({ ok: true, queued: 0, reason: "no_integration" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Queue all events ────────────────────────────────────
  let queued = 0;
  let skipped = 0;

  // Queue inbound messages
  for (const msg of parsed.messages) {
    const idempotencyKey = `msg_${msg.providerMessageId}`;

    const { error } = await supabase.from("whatsapp_event_queue").insert({
      event_type: "message_inbound",
      workspace_id: workspaceId,
      integration_id: integrationId,
      provider: "meta",
      idempotency_key: idempotencyKey,
      raw_payload: {
        providerMessageId: msg.providerMessageId,
        senderPhone: msg.senderPhone,
        timestamp: msg.timestamp,
        bodyText: msg.bodyText,
        mediaType: msg.mediaType,
      },
    });

    if (error) {
      if (error.code === "23505") {
        // Unique constraint violation = duplicate, skip silently
        skipped++;
      } else {
        console.error("[whatsapp-webhook] Failed to queue message:", error);
      }
    } else {
      queued++;
    }
  }

  // Queue status updates
  for (const status of parsed.statusUpdates) {
    const idempotencyKey = `status_${status.providerMessageId}_${status.status}`;

    const { error } = await supabase.from("whatsapp_event_queue").insert({
      event_type: "status_update",
      workspace_id: workspaceId,
      integration_id: integrationId,
      provider: "meta",
      idempotency_key: idempotencyKey,
      raw_payload: {
        providerMessageId: status.providerMessageId,
        status: status.status,
        recipientId: status.recipientId,
      },
    });

    if (error) {
      if (error.code === "23505") {
        skipped++;
      } else {
        console.error("[whatsapp-webhook] Failed to queue status:", error);
      }
    } else {
      queued++;
    }
  }

  console.log(`[whatsapp-webhook] Queued: ${queued}, Skipped (dupes): ${skipped}`);

  // Return 200 immediately — Meta requires fast responses
  return new Response(
    JSON.stringify({ ok: true, queued, skipped }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
});
