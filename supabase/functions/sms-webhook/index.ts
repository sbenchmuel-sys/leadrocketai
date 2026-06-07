// ============================================================
// sms-webhook — Receive inbound SMS replies from Twilio
//
// Twilio sends form-encoded POST with X-Twilio-Signature.
// We verify, match to lead by phone number, store interaction
// + timeline entry, and return TwiML 200.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateTwilioSignature } from "../_shared/twilioSignature.ts";
import { projectTimelineItem } from "../_shared/timelineProjector.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function digits(raw: string): string {
  return (raw ?? "").replace(/\D/g, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("<Response></Response>", {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "text/xml" },
    });
  }

  // Fail-closed: without an auth token we cannot verify the signature, so reject.
  const twilioAuthToken = Deno.env.get("TWILIO_AUTH_TOKEN");
  if (!twilioAuthToken) {
    console.error("[sms-webhook] TWILIO_AUTH_TOKEN not configured — rejecting");
    return new Response("<Response></Response>", {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "text/xml" },
    });
  }

  // ── Read raw body (form-encoded) ───────────────────
  const rawBody = await req.text();
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(rawBody)) {
    params[key] = value;
  }

  // ── Signature verification ─────────────────────────
  // req.url is the internal container URL; Twilio signs against the public URL
  const publicUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/sms-webhook`;
  const signature = req.headers.get("X-Twilio-Signature") ?? "";
  const isValid = await validateTwilioSignature(
    twilioAuthToken,
    signature,
    publicUrl,
    params,
  );
  if (!isValid) {
    console.warn("[sms-webhook] Missing or invalid Twilio signature — rejecting");
    return new Response("<Response></Response>", {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "text/xml" },
    });
  }

  // ── Parse SMS fields ──────────────────────────────
  const messageSid = params.MessageSid ?? params.SmsSid ?? "";
  const from = params.From ?? "";
  const to = params.To ?? "";
  const body = params.Body ?? "";
  const smsStatus = (params.SmsStatus ?? "").toLowerCase();

  // Only process inbound messages (SmsStatus = "received")
  if (smsStatus !== "received") {
    console.log(`[sms-webhook] Non-inbound status: ${smsStatus}, ignoring`);
    return new Response("<Response></Response>", {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/xml" },
    });
  }

  if (!body.trim()) {
    console.log("[sms-webhook] Empty body, ignoring");
    return new Response("<Response></Response>", {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/xml" },
    });
  }

  console.log(`[sms-webhook] Inbound SMS from=${from} to=${to} sid=${messageSid}`);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── Match to lead by phone number ─────────────────
  const fromDigits = digits(from);
  const toDigits = digits(to);

  // Try to find a lead whose phone matches the sender
  const { data: leads } = await supabase
    .from("leads")
    .select("id, workspace_id, owner_user_id, name, company, stage")
    .or(`phone.eq.${from},phone.eq.+${fromDigits},phone.ilike.%${fromDigits.slice(-10)}`)
    .limit(5);

  if (!leads || leads.length === 0) {
    console.warn(`[sms-webhook] No lead found for phone=${from} (${fromDigits})`);
    // Still return 200 so Twilio doesn't retry
    return new Response("<Response></Response>", {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/xml" },
    });
  }

  // If multiple matches, prefer leads whose workspace has this Twilio number
  let matchedLead = leads[0];
  if (leads.length > 1) {
    for (const lead of leads) {
      const { data: ws } = await supabase
        .from("workspaces")
        .select("default_sms_number")
        .eq("id", lead.workspace_id)
        .single();
      if (ws?.default_sms_number && digits(ws.default_sms_number) === toDigits) {
        matchedLead = lead;
        break;
      }
    }
  }

  const leadId = matchedLead.id;
  const workspaceId = matchedLead.workspace_id;
  const occurredAt = new Date().toISOString();
  const dedupeKey = `sms:inbound:${messageSid}`;

  // ── Create interaction ────────────────────────────
  const { data: interactionRow, error: insertErr } = await supabase
    .from("interactions")
    .insert({
      lead_id: leadId,
      type: "sms_inbound",
      source: "sms",
      direction: "inbound",
      occurred_at: occurredAt,
      body_text: body,
      from_email: from,   // reusing field for sender phone
      to_email: to,        // reusing field for recipient phone
      dedupe_key: dedupeKey,
    })
    .select("id")
    .single();

  if (insertErr) {
    if (insertErr.code === "23505") {
      console.log(`[sms-webhook] Duplicate SMS ${messageSid}, skipping`);
    } else {
      console.error("[sms-webhook] Insert error:", insertErr.message);
    }
    return new Response("<Response></Response>", {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/xml" },
    });
  }

  console.log(`[sms-webhook] Interaction created: ${interactionRow.id} for lead ${leadId}`);

  // ── Project to timeline ───────────────────────────
  await projectTimelineItem(supabase, {
    workspace_id: workspaceId,
    lead_id: leadId,
    channel: "sms",
    provider: "twilio",
    direction: "inbound",
    event_type: "sms_inbound",
    occurred_at: occurredAt,
    source_table: "interactions",
    source_id: interactionRow.id,
    snippet_text: body.substring(0, 500),
    metadata_json: { twilio_message_sid: messageSid, from, to },
    dedupe_key: dedupeKey,
  }).catch(e => console.warn("[sms-webhook] Timeline projection failed:", e));

  // ── Update lead timestamps ────────────────────────
  await supabase
    .from("leads")
    .update({
      last_activity_at: occurredAt,
      last_inbound_at: occurredAt,
    })
    .eq("id", leadId)
    .then(({ error }) => {
      if (error) console.warn("[sms-webhook] Lead update error:", error.message);
    });

  // ── Fire-and-forget: trigger intelligence recompute ──
  const internalSecret = Deno.env.get("INTERNAL_API_SECRET");
  if (internalSecret) {
    fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/recompute-lead-intelligence`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": internalSecret,
      },
      body: JSON.stringify({ lead_id: leadId }),
    }).catch(err => console.warn("[sms-webhook] Recompute trigger failed:", err.message));
  }

  // Return TwiML empty response
  return new Response("<Response></Response>", {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/xml" },
  });
});
