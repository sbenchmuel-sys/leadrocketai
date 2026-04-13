// ============================================================
// Twilio Voice Webhook — Status Callback + Recording handler
// Validates X-Twilio-Signature, upserts idempotently
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { mapTwilioStatus, enqueueCallJob, CALL_DEFAULTS } from "../_shared/callConfig.ts";
import { validateTwilioSignature } from "../_shared/twilioSignature.ts";
import { resolvePhoneMapping } from "../_shared/phoneMapping.ts";
import { projectTimelineItem, callDedupeKey } from "../_shared/timelineProjector.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EMPTY_TWIML = "<Response></Response>";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const twilioAuthToken = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    // ---- Parse form data ----
    const formData = await req.formData();
    const params: Record<string, string> = {};
    formData.forEach((value, key) => {
      params[key] = value.toString();
    });

    // ---- Validate Twilio signature ----
    const signature = req.headers.get("X-Twilio-Signature");
    if (twilioAuthToken && signature) {
      // Use public SUPABASE_URL — Twilio computes signatures against the public
      // webhook URL, not the internal container URL that req.url returns.
      const publicUrl = `${supabaseUrl}/functions/v1/twilio-voice-webhook`;
      const isValid = await validateTwilioSignature(
        twilioAuthToken,
        signature,
        publicUrl,
        params,
      );
      if (!isValid) {
        logger.warn("twilio_signature_invalid", { callSid: params.CallSid });
        return new Response(EMPTY_TWIML, {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "text/xml" },
        });
      }
    } else if (twilioAuthToken) {
      // Signature header missing but auth token is set — reject
      logger.warn("twilio_signature_missing", { callSid: params.CallSid });
      return new Response(EMPTY_TWIML, {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "text/xml" },
      });
    }
    // If no auth token configured, allow (development mode)

    // ---- Route by event type ----
    const isRecordingEvent = !!params.RecordingSid;
    const eventType = isRecordingEvent ? "recording_status" : "call_status";

    // Log raw webhook payload
    await supabase.from("call_webhook_log").insert({
      event_type: eventType,
      call_sid: params.CallSid ?? null,
      payload: params,
    });

    if (isRecordingEvent) {
      // Recording callbacks often include CallStatus=completed + CallDuration.
      // Process the call-status side first so the session gets updated,
      // then handle the recording itself.
      if (params.CallStatus) {
        await handleCallStatus(supabase, params);
      }
      await handleRecordingStatus(supabase, params);
    } else {
      await handleCallStatus(supabase, params);
    }

    return new Response(EMPTY_TWIML, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/xml" },
    });
  } catch (err) {
    logger.error("twilio_voice_webhook_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Always return 200 to Twilio to prevent retries on our errors
    return new Response(EMPTY_TWIML, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/xml" },
    });
  }
});

// ============================================================
// Call Status Handler — Idempotent upsert by CallSid
// ============================================================
async function handleCallStatus(
  supabase: ReturnType<typeof createClient>,
  params: Record<string, string>,
) {
  const callSid = params.CallSid;
  if (!callSid) return;

  const status = mapTwilioStatus(params.CallStatus ?? "");
  const direction =
    params.Direction === "outbound-api" || params.Direction === "outbound-dial"
      ? "outbound"
      : "inbound";
  const fromNumber = params.From ?? "";
  const toNumber = params.To ?? "";

  // Build update fields based on status
  const updateFields: Record<string, unknown> = {
    status,
    direction,
    from_number: fromNumber,
    to_number: toNumber,
    updated_at: new Date().toISOString(),
  };

  if (status === "initiated") {
    updateFields.started_at = new Date().toISOString();
  }
  if (status === "answered") {
    updateFields.answered_at = new Date().toISOString();
  }
  if (status === "completed" || status === "failed" || status === "busy" || status === "no-answer" || status === "canceled") {
    updateFields.ended_at = new Date().toISOString();
    if (params.CallDuration) {
      updateFields.duration_sec = parseInt(params.CallDuration, 10);
    }
  }

  // Idempotent upsert: try update first, insert if not found
  const { data: existing } = await supabase
    .from("call_sessions")
    .select("id, workspace_id")
    .eq("call_sid", callSid)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("call_sessions")
      .update(updateFields)
      .eq("call_sid", callSid);
    logger.info("call_session_updated", { callSid, status });
  } else {
    // Resolve phone mapping for new sessions
    const mapping = await resolvePhoneMapping(supabase, fromNumber, toNumber, direction as "inbound" | "outbound");

    if (!mapping.workspaceId) {
      logger.error("call_session_no_workspace", { callSid });
      return;
    }

    // Insert — unique constraint on call_sid ensures idempotency on race
    const { error: insertErr } = await supabase.from("call_sessions").insert({
      call_sid: callSid,
      workspace_id: mapping.workspaceId,
      direction,
      from_number: fromNumber,
      to_number: toNumber,
      status,
      started_at: new Date().toISOString(),
      customer_contact_id: mapping.customerContactId,
      lead_id: mapping.leadId,
      agent_user_id: mapping.agentUserId,
      ...(status === "answered" ? { answered_at: new Date().toISOString() } : {}),
    });

    if (insertErr) {
      // If unique violation, it's a duplicate — just update
      if (insertErr.code === "23505") {
        await supabase
          .from("call_sessions")
          .update(updateFields)
          .eq("call_sid", callSid);
        logger.info("call_session_upserted_on_conflict", { callSid, status });
      } else {
        logger.error("call_session_insert_error", { callSid, error: insertErr.message });
      }
    } else {
      logger.info("call_session_created", { callSid, status, workspaceId: mapping.workspaceId });
    }
  }

  // ---- Project completed/answered calls to lead timeline ----
  const isTerminal = ["completed", "failed", "busy", "no-answer", "canceled"].includes(status);
  if (isTerminal) {
    // Re-fetch session to get lead_id and workspace_id
    const { data: sess } = await supabase
      .from("call_sessions")
      .select("id, workspace_id, lead_id, duration_sec, direction, started_at")
      .eq("call_sid", callSid)
      .maybeSingle();

    if (sess?.lead_id && sess.workspace_id) {
      const durationSec = params.CallDuration ? parseInt(params.CallDuration, 10) : sess.duration_sec;
      const snippet = status === "completed"
        ? `Phone call (${sess.direction}) — ${durationSec ? `${Math.ceil(durationSec / 60)} min` : "unknown duration"}`
        : `Phone call (${sess.direction}) — ${status}`;

      await projectTimelineItem(supabase, {
        workspace_id: sess.workspace_id,
        lead_id: sess.lead_id,
        channel: "voice",
        provider: "twilio",
        direction: sess.direction as "inbound" | "outbound",
        event_type: `call_${status}`,
        occurred_at: sess.started_at ?? new Date().toISOString(),
        source_table: "call_sessions",
        source_id: sess.id,
        snippet_text: snippet,
        metadata_json: { call_sid: callSid, duration_sec: durationSec, status },
        dedupe_key: callDedupeKey(sess.id),
      }, { triggerRecompute: status === "completed" });

      logger.info("call_timeline_projected", { callSid, leadId: sess.lead_id, status });
    }
  }
}

// ============================================================
// Recording Status Handler — Idempotent upsert by RecordingSid
// Applies cost-control gate for short recordings
// ============================================================
async function handleRecordingStatus(
  supabase: ReturnType<typeof createClient>,
  params: Record<string, string>,
) {
  const callSid = params.CallSid;
  const recordingSid = params.RecordingSid;
  const recordingStatus = params.RecordingStatus;

  if (!callSid || !recordingSid) return;

  // Only process completed recordings
  if (recordingStatus !== "completed") {
    logger.info("recording_status_ignored", { recordingSid, recordingStatus });
    return;
  }

  // Find call session
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

  if (!recordingUrl) {
    logger.warn("recording_missing_url", { recordingSid });
    return;
  }

  // Fetch workspace-specific settings or use defaults
  const { data: settings } = await supabase
    .from("call_settings")
    .select("transcribe_min_duration_sec")
    .eq("workspace_id", session.workspace_id)
    .maybeSingle();

  const minDuration = settings?.transcribe_min_duration_sec ?? CALL_DEFAULTS.TRANSCRIBE_MIN_DURATION_SEC;

  // Cost control gate: skip short recordings
  const isShort = durationSec != null && durationSec < minDuration;
  const recordingRow = {
    call_session_id: session.id,
    recording_sid: recordingSid,
    twilio_recording_url: recordingUrl,
    duration_sec: durationSec,
    channels,
    status: isShort ? "skipped_short" : "completed",
  };

  // Idempotent upsert: check if recording already exists
  const { data: existingRec } = await supabase
    .from("call_recordings")
    .select("id")
    .eq("recording_sid", recordingSid)
    .maybeSingle();

  let recordingId: string;

  if (existingRec) {
    // Already processed — update in case of status change
    await supabase
      .from("call_recordings")
      .update(recordingRow)
      .eq("recording_sid", recordingSid);
    recordingId = existingRec.id;
    logger.info("recording_upserted", { recordingSid, status: recordingRow.status });
  } else {
    const { data: rec, error } = await supabase
      .from("call_recordings")
      .insert(recordingRow)
      .select("id")
      .single();

    if (error) {
      // Unique constraint violation = duplicate delivery
      if (error.code === "23505") {
        logger.info("recording_duplicate_ignored", { recordingSid });
        return;
      }
      logger.error("recording_insert_error", { error: error.message, recordingSid });
      return;
    }
    recordingId = rec.id;
    logger.info("recording_created", { recordingSid, callSessionId: session.id, status: recordingRow.status });
  }

  // Only enqueue ingestion if not short
  if (!isShort) {
    await enqueueCallJob({
      type: "ingest_recording",
      callSessionId: session.id,
      recordingId,
    });
  } else {
    logger.info("recording_skipped_short", { recordingSid, durationSec, minDuration });
  }
}
