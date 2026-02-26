// ============================================================
// Twilio Voice Webhook — Status Callback + Recording handler
// Receives form-encoded POST from Twilio
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { mapTwilioStatus, enqueueCallJob } from "../_shared/callConfig.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const formData = await req.formData();
    const params: Record<string, string> = {};
    formData.forEach((value, key) => {
      params[key] = value.toString();
    });

    const eventType = params.RecordingSid ? "recording_status" : "call_status";

    // Log webhook delivery
    await supabase.from("call_webhook_log").insert({
      event_type: eventType,
      call_sid: params.CallSid ?? null,
      payload: params,
    });

    logger.info("twilio_voice_webhook_received", { eventType, callSid: params.CallSid });

    if (eventType === "call_status") {
      await handleCallStatus(supabase, params);
    } else {
      await handleRecordingStatus(supabase, params);
    }

    // Twilio expects 200 with TwiML or empty body
    return new Response("<Response></Response>", {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/xml" },
    });
  } catch (err) {
    logger.error("twilio_voice_webhook_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response("<Response></Response>", {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/xml" },
    });
  }
});

async function handleCallStatus(
  supabase: ReturnType<typeof createClient>,
  params: Record<string, string>
) {
  const callSid = params.CallSid;
  if (!callSid) return;

  const status = mapTwilioStatus(params.CallStatus ?? "");
  const direction = params.Direction === "outbound-api" || params.Direction === "outbound-dial"
    ? "outbound"
    : "inbound";

  // Upsert call session
  const updateFields: Record<string, unknown> = {
    status,
    direction,
    from_number: params.From ?? "",
    to_number: params.To ?? "",
    updated_at: new Date().toISOString(),
  };

  if (status === "answered" || status === "in-progress") {
    updateFields.answered_at = new Date().toISOString();
  }

  if (status === "completed") {
    updateFields.ended_at = new Date().toISOString();
    updateFields.duration_sec = params.CallDuration ? parseInt(params.CallDuration, 10) : null;
  }

  // Try to find existing session
  const { data: existing } = await supabase
    .from("call_sessions")
    .select("id")
    .eq("call_sid", callSid)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("call_sessions")
      .update(updateFields)
      .eq("call_sid", callSid);

    logger.info("call_session_updated", { callSid, status });
  } else {
    // We need a workspace_id — look up from the Twilio phone number or use a default
    // For now, we'll need to resolve this from the phone number mapping
    // Placeholder: first workspace (to be refined with phone-to-workspace mapping)
    const { data: ws } = await supabase
      .from("workspaces")
      .select("id")
      .limit(1)
      .single();

    if (!ws) {
      logger.error("call_session_no_workspace", { callSid });
      return;
    }

    await supabase.from("call_sessions").insert({
      call_sid: callSid,
      workspace_id: ws.id,
      direction,
      from_number: params.From ?? "",
      to_number: params.To ?? "",
      status,
      started_at: new Date().toISOString(),
      ...(status === "answered" ? { answered_at: new Date().toISOString() } : {}),
    });

    logger.info("call_session_created", { callSid, status, workspaceId: ws.id });
  }
}

async function handleRecordingStatus(
  supabase: ReturnType<typeof createClient>,
  params: Record<string, string>
) {
  const callSid = params.CallSid;
  const recordingSid = params.RecordingSid;
  const recordingStatus = params.RecordingStatus;

  if (!callSid || !recordingSid) return;

  // Find the call session
  const { data: session } = await supabase
    .from("call_sessions")
    .select("id, workspace_id")
    .eq("call_sid", callSid)
    .maybeSingle();

  if (!session) {
    logger.warn("recording_no_session", { callSid, recordingSid });
    return;
  }

  const durationSec = params.RecordingDuration ? parseInt(params.RecordingDuration, 10) : null;
  const channels = params.RecordingChannels ? parseInt(params.RecordingChannels, 10) : 1;
  const recordingUrl = params.RecordingUrl ?? null;

  if (recordingStatus === "completed") {
    // Insert recording record
    const { data: rec, error } = await supabase.from("call_recordings").insert({
      call_session_id: session.id,
      recording_sid: recordingSid,
      twilio_recording_url: recordingUrl,
      duration_sec: durationSec,
      channels,
      status: "completed",
    }).select("id").single();

    if (error) {
      logger.error("recording_insert_error", { error: error.message, recordingSid });
      return;
    }

    logger.info("recording_created", { recordingSid, callSessionId: session.id });

    // Enqueue ingestion job
    await enqueueCallJob({
      type: "ingest_recording",
      callSessionId: session.id,
      recordingId: rec.id,
    });
  } else {
    logger.info("recording_status_ignored", { recordingSid, recordingStatus });
  }
}
