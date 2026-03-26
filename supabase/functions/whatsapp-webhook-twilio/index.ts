// ============================================================
// whatsapp-webhook-twilio — INGEST-ONLY for Twilio webhooks
//
// Twilio sends form-encoded POST requests with X-Twilio-Signature.
// We verify, normalize, route, store in channel_events, return 200.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyTwilioSignature } from "../_shared/whatsapp/providers/twilio.ts";
import { normalizeTwilioWebhook } from "../_shared/whatsapp/normalizeTwilio.ts";
import { toChannelEventRows } from "../_shared/whatsapp/normalize.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  // ── Read raw body (form-encoded) ───────────────────────
  const rawBody = await req.text();

  // ── Signature verification (MUST happen before any data access) ──
  const twilioAuthToken = Deno.env.get("TWILIO_AUTH_TOKEN");
  if (!twilioAuthToken) {
    console.error("[whatsapp-webhook-twilio] TWILIO_AUTH_TOKEN not configured — rejecting");
    return new Response("<Response></Response>", {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "text/xml" },
    });
  }
  const sigValid = await verifyTwilioSignature(req, rawBody, twilioAuthToken);
  if (!sigValid) {
    console.warn("[whatsapp-webhook-twilio] Invalid Twilio signature — rejecting");
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Parse form-encoded body ────────────────────────────
  const params: Record<string, string> = {};
  const urlParams = new URLSearchParams(rawBody);
  for (const [key, value] of urlParams) {
    params[key] = value;
  }

  // ── Normalize ──────────────────────────────────────────
  const result = normalizeTwilioWebhook(params);
  const totalEvents = result.inboundEvents.length + result.statusEvents.length;

  if (totalEvents === 0) {
    // Return TwiML empty response for Twilio
    return new Response("<Response></Response>", {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/xml" },
    });
  }

  // ── Route: resolve workspace ───────────────────────────
  // For Twilio, provider_account_id stores the Twilio sender number (digits only)
  let workspaceId: string | null = null;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  if (result.phoneNumberId) {
    const { data: integration } = await supabase
      .from("integrations")
      .select("workspace_id")
      .eq("type", "whatsapp")
      .eq("provider", "twilio")
      .eq("is_active", true)
      .eq("provider_account_id", result.phoneNumberId)
      .maybeSingle();

    workspaceId = integration?.workspace_id ?? null;

    if (!workspaceId) {
      console.warn(
        `[whatsapp-webhook-twilio] No active twilio integration for sender=${result.phoneNumberId}`,
      );
    }
  }

  // ── Convert to channel_events rows ─────────────────────
  const rows = toChannelEventRows(result, workspaceId, params as unknown as Record<string, unknown>);

  let stored = 0;
  let duplicates = 0;

  for (const row of rows) {
    const { error: insertErr } = await supabase
      .from("channel_events")
      .insert(row);

    if (insertErr) {
      if (insertErr.code === "23505") {
        duplicates++;
        continue;
      }
      console.error("[whatsapp-webhook-twilio] Insert error:", insertErr.message);
      continue;
    }
    stored++;
  }

  console.log(
    `[whatsapp-webhook-twilio] Ingested: ${stored} stored, ${duplicates} duplicates, ${totalEvents} total`,
  );

  // ── Fire-and-forget: trigger async processor ───────────
  if (stored > 0) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    fetch(`${supabaseUrl}/functions/v1/whatsapp-events-processor`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${anonKey}`,
      },
      body: JSON.stringify({ trigger: "twilio-webhook", stored }),
    }).catch((err) => {
      console.warn("[whatsapp-webhook-twilio] Failed to trigger processor:", err.message);
    });
  }

  // Return TwiML empty response (Twilio expects XML)
  return new Response("<Response></Response>", {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/xml" },
  });
});
