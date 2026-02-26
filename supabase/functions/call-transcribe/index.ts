// ============================================================
// Call Transcribe — Phase 3 hardened (v2)
// Safe base64 · Insert-first idempotency · Audio size guard
// Language auto-detect always on · Raw transcript preserved
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { CALL_DEFAULTS, enqueueCallJob } from "../_shared/callConfig.ts";
import {
  GeminiAsrProvider,
  normalizeSpeakerRoles,
  cleanSegments,
  formatLlmTranscript,
} from "../_shared/asrProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function respond(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// §1 — Safe chunked base64 conversion (prevents stack overflow on large buffers)
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000; // 32KB chunks
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

const MAX_AUDIO_BYTES = 12 * 1024 * 1024; // 12MB safe limit

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const { callSessionId } = await req.json();

    if (!callSessionId) {
      return respond({ ok: false, error: "Missing callSessionId" }, 400);
    }

    // ---- Fetch session ----
    const { data: session } = await supabase
      .from("call_sessions")
      .select("id, workspace_id, duration_sec, direction, customer_contact_id")
      .eq("id", callSessionId)
      .single();

    if (!session) {
      return respond({ ok: false, error: "Session not found" }, 404);
    }

    // ---- Load workspace settings ----
    const { data: settings } = await supabase
      .from("call_settings")
      .select("*")
      .eq("workspace_id", session.workspace_id)
      .maybeSingle();

    const minDuration = settings?.transcribe_min_duration_sec ?? CALL_DEFAULTS.TRANSCRIBE_MIN_DURATION_SEC;
    const analyzeMin = settings?.analyze_min_duration_sec ?? CALL_DEFAULTS.ANALYZE_MIN_DURATION_SEC;
    const workspaceLang = settings?.default_language ?? CALL_DEFAULTS.DEFAULT_LANGUAGE;
    const supportedLangs = settings?.supported_languages ?? CALL_DEFAULTS.SUPPORTED_LANGUAGES;

    // ---- Duration gate for transcription ----
    if (session.duration_sec != null && session.duration_sec < minDuration) {
      // Use upsert-style insert to avoid duplicate on short calls
      await supabase.from("call_transcripts").upsert({
        call_session_id: callSessionId,
        status: "skipped_short",
        language: workspaceLang,
        provider: "none",
      }, { onConflict: "call_session_id", ignoreDuplicates: true });
      logger.info("transcribe_skipped_short", { callSessionId, durationSec: session.duration_sec });
      return respond({ ok: true, status: "skipped_short" });
    }

    // ---- §2 Insert-first idempotency (race-safe via UNIQUE constraint) ----
    const resolvedLanguage = workspaceLang;

    const { data: transcript, error: insertErr } = await supabase
      .from("call_transcripts")
      .insert({
        call_session_id: callSessionId,
        status: "processing",
        language: resolvedLanguage,
        provider: "lovable-ai",
      })
      .select("id")
      .single();

    if (insertErr) {
      if (insertErr.code === "23505") {
        logger.info("transcribe_already_started_or_completed", { callSessionId });
        return respond({ ok: true, status: "already_started_or_completed" });
      }
      logger.error("transcribe_insert_error", { error: insertErr.message });
      return respond({ ok: false, error: "Failed to create transcript" }, 500);
    }

    if (!transcript) {
      logger.info("transcribe_already_started_or_completed", { callSessionId });
      return respond({ ok: true, status: "already_started_or_completed" });
    }

    // ---- Get recording audio ----
    const { data: recording } = await supabase
      .from("call_recordings")
      .select("storage_url, recording_sid")
      .eq("call_session_id", callSessionId)
      .eq("status", "downloaded")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!recording?.storage_url) {
      await supabase.from("call_transcripts").update({ status: "failed" }).eq("id", transcript.id);
      logger.error("transcribe_no_recording", { callSessionId });
      return respond({ ok: false, error: "No downloaded recording" }, 404);
    }

    if (!lovableApiKey) {
      await supabase.from("call_transcripts").update({ status: "failed" }).eq("id", transcript.id);
      logger.error("transcribe_no_api_key", { callSessionId });
      return respond({ ok: false, error: "LOVABLE_API_KEY not configured" }, 500);
    }

    // ---- Download audio from storage ----
    const storagePath = recording.storage_url.split("/storage/v1/object/")[1];
    const { data: audioData, error: dlErr } = await supabase.storage
      .from("call-recordings")
      .download(storagePath?.replace("call-recordings/", "") ?? "");

    if (dlErr || !audioData) {
      await supabase.from("call_transcripts").update({ status: "failed" }).eq("id", transcript.id);
      logger.error("transcribe_download_error", { error: dlErr?.message });
      return respond({ ok: false, error: "Failed to download audio" }, 500);
    }

    // ---- §6 Audio size guard ----
    const audioBuffer = await audioData.arrayBuffer();

    if (audioBuffer.byteLength > MAX_AUDIO_BYTES) {
      logger.warn("audio_too_large", { size: audioBuffer.byteLength, callSessionId });
      await supabase.from("call_transcripts").update({ status: "failed" }).eq("id", transcript.id);
      return respond({ ok: false, error: "Audio too large" }, 400);
    }

    // ---- §1 Safe base64 conversion ----
    const base64Audio = arrayBufferToBase64(audioBuffer);

    // ---- §5 ASR with auto-detect always enabled ----
    const asr = new GeminiAsrProvider(lovableApiKey);

    let asrResult;
    try {
      asrResult = await asr.transcribe(base64Audio, {
        language: resolvedLanguage,
        autoDetect: true, // Always on — bias toward workspace lang but detect actual
        allowedLanguages: supportedLangs as string[],
        diarization: true,
        timestamps: true,
      });
    } catch (err) {
      await supabase.from("call_transcripts").update({ status: "failed" }).eq("id", transcript.id);
      logger.error("transcribe_asr_failed", {
        callSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return respond({ ok: false, error: "ASR transcription failed" }, 500);
    }

    // ---- Diarization normalization ----
    const normalizedSegments = normalizeSpeakerRoles(asrResult.segments, session.direction);

    // ---- Transcript cleanup ----
    const cleanedSegments = cleanSegments(normalizedSegments);

    // ---- §7 Build all transcript versions ----
    const rawFullText = asrResult.fullText;
    const cleanFullText = cleanedSegments.map((s) => s.text).join(" ");
    const llmFormattedText = formatLlmTranscript(cleanedSegments);

    // ---- Persist completed transcript ----
    await supabase.from("call_transcripts").update({
      status: "completed",
      segments_json: cleanedSegments,
      full_text: llmFormattedText, // backward compat
      raw_full_text: rawFullText,
      clean_full_text: cleanFullText,
      llm_formatted_text: llmFormattedText,
      language: asrResult.language,
      confidence: asrResult.confidence ?? null,
    }).eq("id", transcript.id);

    logger.info("transcribe_complete", {
      callSessionId,
      transcriptId: transcript.id,
      detectedLanguage: asrResult.language,
      confidence: asrResult.confidence,
      segmentCount: cleanedSegments.length,
    });

    // ---- §4 Analysis gate (idempotent via UNIQUE constraint) ----
    if (session.duration_sec != null && session.duration_sec < analyzeMin) {
      await supabase.from("call_analyses").upsert({
        call_session_id: callSessionId,
        status: "skipped_short",
      }, { onConflict: "call_session_id", ignoreDuplicates: true });
      logger.info("analyze_skipped_short", {
        callSessionId,
        durationSec: session.duration_sec,
        minRequired: analyzeMin,
      });
    } else {
      await enqueueCallJob({
        type: "analyze_call",
        callSessionId,
      });
    }

    return respond({ ok: true, transcriptId: transcript.id });
  } catch (err) {
    logger.error("transcribe_error", { error: err instanceof Error ? err.message : String(err) });
    return respond({ ok: false, error: "Internal error" }, 500);
  }
});
