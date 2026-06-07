// ============================================================
// Call Ingest Recording — Download from Twilio → Supabase Storage
// Then enqueue transcription
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { CALL_DEFAULTS, enqueueCallJob } from "../_shared/callConfig.ts";

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
  const twilioSid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const twilioToken = Deno.env.get("TWILIO_AUTH_TOKEN");
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const { callSessionId, recordingId } = await req.json();

    if (!recordingId) {
      return new Response(JSON.stringify({ ok: false, error: "Missing recordingId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch recording metadata
    const { data: recording, error: recErr } = await supabase
      .from("call_recordings")
      .select("*")
      .eq("id", recordingId)
      .single();

    if (recErr || !recording) {
      logger.error("ingest_recording_not_found", { recordingId, error: recErr?.message });
      return new Response(JSON.stringify({ ok: false, error: "Recording not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Skip short recordings
    if (recording.duration_sec != null && recording.duration_sec < CALL_DEFAULTS.TRANSCRIBE_MIN_DURATION_SEC) {
      await supabase
        .from("call_recordings")
        .update({ status: "skipped_short" })
        .eq("id", recordingId);

      logger.info("ingest_skipped_short", { recordingId, durationSec: recording.duration_sec });
      return new Response(JSON.stringify({ ok: true, status: "skipped_short" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Download from Twilio
    if (!recording.twilio_recording_url || !twilioSid || !twilioToken) {
      logger.error("ingest_missing_config", { recordingId, hasTwilioUrl: !!recording.twilio_recording_url });
      await supabase.from("call_recordings").update({ status: "failed" }).eq("id", recordingId);
      return new Response(JSON.stringify({ ok: false, error: "Missing Twilio config or URL" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const audioUrl = `${recording.twilio_recording_url}.wav`;
    // Prefer API Key auth for outbound REST; fall back to Account SID:Auth Token.
    // Account SID stays in the URL path either way.
    const apiKey = Deno.env.get("TWILIO_API_KEY");
    const apiSecret = Deno.env.get("TWILIO_API_SECRET");
    const authHeader = apiKey && apiSecret
      ? btoa(`${apiKey}:${apiSecret}`)
      : btoa(`${twilioSid}:${twilioToken}`);

    const audioResp = await fetch(audioUrl, {
      headers: { Authorization: `Basic ${authHeader}` },
    });

    if (!audioResp.ok) {
      const errText = await audioResp.text();
      logger.error("ingest_download_failed", { recordingId, status: audioResp.status, error: errText });
      await supabase.from("call_recordings").update({ status: "failed" }).eq("id", recordingId);
      return new Response(JSON.stringify({ ok: false, error: "Download failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const audioBuffer = await audioResp.arrayBuffer();

    // Compute SHA-256
    const hashBuffer = await crypto.subtle.digest("SHA-256", audioBuffer);
    const sha256 = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    // Upload to Supabase Storage
    const storagePath = `${callSessionId}/${recording.recording_sid}.wav`;
    const { error: uploadErr } = await supabase.storage
      .from("call-recordings")
      .upload(storagePath, audioBuffer, {
        contentType: "audio/wav",
        upsert: true,
      });

    if (uploadErr) {
      logger.error("ingest_upload_failed", { recordingId, error: uploadErr.message });
      await supabase.from("call_recordings").update({ status: "failed" }).eq("id", recordingId);
      return new Response(JSON.stringify({ ok: false, error: "Upload failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update recording record
    const storageFullUrl = `${supabaseUrl}/storage/v1/object/call-recordings/${storagePath}`;
    await supabase.from("call_recordings").update({
      status: "downloaded",
      downloaded_at: new Date().toISOString(),
      storage_url: storageFullUrl,
      storage_path: storagePath,
      storage_provider: "supabase",
      sha256,
      format: "wav",
    }).eq("id", recordingId);

    logger.info("ingest_recording_complete", { recordingId, callSessionId, sha256 });

    // Enqueue transcription
    await enqueueCallJob({
      type: "transcribe_call",
      callSessionId,
      recordingId,
    });

    return new Response(JSON.stringify({ ok: true, status: "downloaded" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    logger.error("ingest_recording_error", { error: err instanceof Error ? err.message : String(err) });
    return new Response(JSON.stringify({ ok: false, error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
