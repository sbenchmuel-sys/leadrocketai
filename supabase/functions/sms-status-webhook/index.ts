// ============================================================
// sms-status-webhook — Twilio SMS delivery-status callback
//
// Twilio POSTs form-encoded status events (queued/sent/delivered/
// undelivered/failed) for outbound SMS we sent with StatusCallback.
//
// Pipeline:
//  1. Verify X-Twilio-Signature against PUBLIC function URL.
//  2. Idempotently insert into channel_events (provider='twilio',
//     channel='sms', event_type='status_update',
//     provider_event_id='{MessageSid}:{MessageStatus}').
//  3. Reconcile into lead_timeline_items via
//     dedupe_key='sms:outbound:{MessageSid}' — workspace-scoped,
//     no cross-workspace leakage.
//  4. Always return 200 to avoid Twilio retry storms.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateTwilioSignature } from "../_shared/twilioSignature.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const EMPTY_TWIML = "<Response></Response>";

function twiml(status = 200) {
  return new Response(EMPTY_TWIML, {
    status,
    headers: { ...corsHeaders, "Content-Type": "text/xml" },
  });
}

const TERMINAL_DELIVERED = new Set(["delivered"]);
const TERMINAL_FAILED = new Set(["failed", "undelivered"]);
const ALLOWED_STATUSES = new Set([
  "queued",
  "sending",
  "sent",
  "delivered",
  "undelivered",
  "failed",
  "read",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return twiml(405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const twilioAuthToken = Deno.env.get("TWILIO_AUTH_TOKEN");

  if (!twilioAuthToken) {
    console.error("[sms-status-webhook] TWILIO_AUTH_TOKEN not configured");
    return twiml(200); // don't induce retries
  }

  // ── Read raw body ──────────────────────────────────────
  const rawBody = await req.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(rawBody)) params[k] = v;

  // ── Signature verification (against public URL) ───────
  const publicUrl = `${supabaseUrl}/functions/v1/sms-status-webhook`;
  const signature = req.headers.get("X-Twilio-Signature") ?? "";
  const sigValid = await validateTwilioSignature(
    twilioAuthToken,
    signature,
    publicUrl,
    params,
  );
  if (!sigValid) {
    console.warn("[sms-status-webhook] invalid_signature", {
      messageSid: params.MessageSid ?? null,
    });
    return twiml(401);
  }

  const messageSid = params.MessageSid ?? params.SmsSid ?? "";
  const messageStatus = (params.MessageStatus ?? params.SmsStatus ?? "").toLowerCase();
  const errorCode = params.ErrorCode ?? null;
  const errorMessage = params.ErrorMessage ?? null;

  if (!messageSid || !messageStatus) {
    console.warn("[sms-status-webhook] missing_fields", { messageSid, messageStatus });
    return twiml(200);
  }

  if (!ALLOWED_STATUSES.has(messageStatus)) {
    // Unknown status — store nothing, ack to stop retries.
    console.log("[sms-status-webhook] ignoring_status", { messageSid, messageStatus });
    return twiml(200);
  }

  console.log("[sms-status-webhook] received", {
    messageSid,
    messageStatus,
    errorCode,
  });

  const supabase = createClient(supabaseUrl, serviceKey);

  // ── 1. Find the originating outbound timeline item ────
  // Workspace is derived from THIS row only — no cross-workspace risk.
  const dedupeKey = `sms:outbound:${messageSid}`;
  const { data: timelineItem } = await supabase
    .from("lead_timeline_items")
    .select("id, workspace_id, lead_id, metadata_json")
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();

  const workspaceId = timelineItem?.workspace_id ?? null;

  // ── 2. Idempotent raw event store ─────────────────────
  const providerEventId = `${messageSid}:${messageStatus}`;
  const { error: insertErr } = await supabase
    .from("channel_events")
    .insert({
      workspace_id: workspaceId,
      channel: "sms",
      provider: "twilio",
      event_type: "status_update",
      provider_event_id: providerEventId,
      payload_normalized: {
        message_sid: messageSid,
        status: messageStatus,
        error_code: errorCode,
        error_message: errorMessage,
        to: params.To ?? null,
        from: params.From ?? null,
      },
      payload_raw: params,
      processed_at: new Date().toISOString(),
    });

  let duplicate = false;
  if (insertErr) {
    if (insertErr.code === "23505") {
      duplicate = true;
    } else {
      console.error("[sms-status-webhook] channel_events_insert_error", {
        messageSid,
        code: insertErr.code,
        message: insertErr.message,
      });
      // Continue — reconciliation is still useful.
    }
  }

  // ── 3. Reconcile into the outbound timeline row ───────
  if (!timelineItem) {
    console.warn("[sms-status-webhook] outbound_timeline_missing", {
      messageSid,
      messageStatus,
    });
    return twiml(200);
  }

  // Skip metadata update for pure duplicate replays.
  if (duplicate) {
    console.log("[sms-status-webhook] duplicate_status_event", {
      messageSid,
      messageStatus,
    });
    return twiml(200);
  }

  const now = new Date().toISOString();
  const existingMeta = (timelineItem.metadata_json ?? {}) as Record<string, unknown>;

  const nextMeta: Record<string, unknown> = {
    ...existingMeta,
    status: messageStatus,
    status_updated_at: now,
  };
  if (errorCode) nextMeta.error_code = errorCode;
  if (errorMessage) nextMeta.error_message = errorMessage;
  if (TERMINAL_DELIVERED.has(messageStatus)) nextMeta.delivered_at = now;
  if (TERMINAL_FAILED.has(messageStatus)) nextMeta.failed_at = now;

  const { error: updateErr } = await supabase
    .from("lead_timeline_items")
    .update({ metadata_json: nextMeta })
    .eq("id", timelineItem.id);

  if (updateErr) {
    console.error("[sms-status-webhook] timeline_update_error", {
      messageSid,
      code: updateErr.code,
      message: updateErr.message,
    });
    return twiml(200);
  }

  console.log("[sms-status-webhook] status_reconciled", {
    messageSid,
    messageStatus,
    leadId: timelineItem.lead_id,
    workspaceId,
  });

  return twiml(200);
});
