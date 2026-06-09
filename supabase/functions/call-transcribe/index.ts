// ============================================================
// Call Transcribe — Phase 3 hardened (v2)
// Safe base64 · Insert-first idempotency · Audio size guard
// Language auto-detect always on · Raw transcript preserved
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { CALL_DEFAULTS, enqueueCallJob } from "../_shared/callConfig.ts";
import {
  GoogleSpeechAsrProvider,
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

// Upper memory bound for the raw recording buffer. The ASR provider chunks audio
// into ~55s slices internally, so the whole file never has to fit in one Google
// request — this only guards edge-function memory. Long sales calls (a 15-min
// dual-channel WAV is ~25-30MB) must stay under it.
const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 50MB

// Wall-clock budget for the chunked ASR loop. Leaves headroom under the edge
// function limit so a run that can't finish marks the transcript failed (and can
// be retried) instead of being hard-killed mid-flight.
const TRANSCRIBE_BUDGET_MS = 120_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startedAt = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const googleSpeechApiKey = Deno.env.get("GOOGLE_SPEECH_API_KEY");
  const supabase = createClient(supabaseUrl, serviceKey);

  // Hoisted so the outer catch can mark the transcript failed rather than leaving
  // it stuck in "processing".
  let transcriptId: string | null = null;

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
    // Allow retry of failed transcripts by deleting the old record first
    const resolvedLanguage = workspaceLang;

    // Check for existing transcript
    const { data: existing } = await supabase
      .from("call_transcripts")
      .select("id, status")
      .eq("call_session_id", callSessionId)
      .maybeSingle();

    if (existing) {
      if (existing.status === "completed" || existing.status === "processing") {
        logger.info("transcribe_already_started_or_completed", { callSessionId, status: existing.status });
        return respond({ ok: true, status: "already_started_or_completed" });
      }
      // Failed or skipped — delete to allow retry
      await supabase.from("call_transcripts").delete().eq("id", existing.id);
      logger.info("transcribe_retry_cleared", { callSessionId, oldStatus: existing.status });
    }

    const { data: transcript, error: insertErr } = await supabase
      .from("call_transcripts")
      .insert({
        call_session_id: callSessionId,
        status: "processing",
        language: resolvedLanguage,
        provider: "google-speech",
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

    transcriptId = transcript.id;

    // ---- Get recording audio ----
    const { data: recording } = await supabase
      .from("call_recordings")
      .select("storage_url, recording_sid, channels")
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

    if (!googleSpeechApiKey) {
      await supabase.from("call_transcripts").update({ status: "failed" }).eq("id", transcript.id);
      logger.error("transcribe_no_google_speech_key", { callSessionId });
      return respond({ ok: false, error: "GOOGLE_SPEECH_API_KEY not configured" }, 500);
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
    logger.info("transcribe_audio_downloaded", { callSessionId, audioBytes: audioBuffer.byteLength });

    if (audioBuffer.byteLength > MAX_AUDIO_BYTES) {
      logger.warn("audio_too_large", { size: audioBuffer.byteLength, max: MAX_AUDIO_BYTES, callSessionId });
      await supabase.from("call_transcripts").update({ status: "failed" }).eq("id", transcript.id);
      return respond({ ok: false, error: "Audio too large" }, 400);
    }

    // ---- ASR via Google Speech-to-Text ----
    // Pass the raw buffer directly (no whole-file base64 step); the provider
    // chunks it into ~55s slices internally and base64-encodes each chunk.
    const asr = new GoogleSpeechAsrProvider(googleSpeechApiKey);

    let asrResult;
    try {
      asrResult = await asr.transcribeBuffer(audioBuffer, {
        language: resolvedLanguage,
        autoDetect: true, // Always on — bias toward workspace lang but detect actual
        allowedLanguages: supportedLangs as string[],
        diarization: true,
        timestamps: true,
        channelCount: recording.channels ?? 1,
        deadlineMs: startedAt + TRANSCRIBE_BUDGET_MS,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await supabase.from("call_transcripts").update({ status: "failed" }).eq("id", transcript.id);
      logger.error("transcribe_asr_failed", {
        callSessionId,
        audioBytes: audioBuffer.byteLength,
        elapsedMs: Date.now() - startedAt,
        reason,
      });
      return respond({ ok: false, error: "ASR transcription failed", reason }, 500);
    }

    // ---- Observability: audio size + chunk count for this run ----
    logger.info("transcribe_audio_stats", {
      callSessionId,
      audioBytes: audioBuffer.byteLength,
      chunkCount: asrResult.chunkCount ?? 1,
      elapsedMs: Date.now() - startedAt,
    });

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
    const reason = err instanceof Error ? err.message : String(err);
    if (transcriptId) {
      // Don't leave the transcript stuck in "processing" — mark it failed so it can retry.
      await supabase.from("call_transcripts").update({ status: "failed" }).eq("id", transcriptId).then(
        () => {},
        (e) => logger.error("transcribe_fail_mark_error", { error: e instanceof Error ? e.message : String(e) }),
      );
    }
    logger.error("transcribe_error", { reason });
    return respond({ ok: false, error: "Internal error", reason }, 500);
  }
});
