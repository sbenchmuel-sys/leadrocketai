// ============================================================
// Call Transcribe — Phase 3 hardened
// Language routing · ASR abstraction · Diarization · Cleanup
// Idempotency · Analysis gate · LLM-ready formatting
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { CALL_DEFAULTS, enqueueCallJob } from "../_shared/callConfig.ts";
import {
  GeminiAsrProvider,
  normalizeSpeakerRoles,
  cleanSegments,
  formatLlmTranscript,
  type AsrSegment,
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

    // ---- Idempotency guard (§6) ----
    const { data: existingTranscript } = await supabase
      .from("call_transcripts")
      .select("id, status")
      .eq("call_session_id", callSessionId)
      .eq("status", "completed")
      .maybeSingle();

    if (existingTranscript) {
      logger.info("transcribe_already_completed", { callSessionId, transcriptId: existingTranscript.id });
      return respond({ ok: true, transcriptId: existingTranscript.id, status: "already_completed" });
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
      await supabase.from("call_transcripts").insert({
        call_session_id: callSessionId,
        status: "skipped_short",
        language: workspaceLang,
        provider: "none",
      });
      logger.info("transcribe_skipped_short", { callSessionId, durationSec: session.duration_sec });
      return respond({ ok: true, status: "skipped_short" });
    }

    // ---- Language resolution (§1) ----
    // Priority: contact preference → workspace default → auto-detect
    let resolvedLanguage: string | undefined;
    let useAutoDetect = false;

    if (session.customer_contact_id) {
      // Check contact preferred_language via contact_identities metadata
      // For now we fall through; contacts table doesn't have preferred_language yet
    }

    if (!resolvedLanguage) {
      resolvedLanguage = workspaceLang;
    }

    // If workspace lang is set but we want to verify, could enable auto-detect
    // For deterministic routing we use workspace lang by default
    // Auto-detect only if explicitly no language could be resolved
    if (!resolvedLanguage) {
      useAutoDetect = true;
      resolvedLanguage = CALL_DEFAULTS.DEFAULT_LANGUAGE;
    }

    // ---- Create transcript record as processing ----
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

    if (insertErr || !transcript) {
      // Possible duplicate from race condition
      if (insertErr?.code === "23505") {
        logger.info("transcribe_duplicate_insert", { callSessionId });
        return respond({ ok: true, status: "duplicate" });
      }
      logger.error("transcribe_insert_error", { error: insertErr?.message });
      return respond({ ok: false, error: "Failed to create transcript" }, 500);
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

    // ---- ASR via provider abstraction (§2) ----
    const audioBuffer = await audioData.arrayBuffer();
    const base64Audio = btoa(String.fromCharCode(...new Uint8Array(audioBuffer)));

    const asr = new GeminiAsrProvider(lovableApiKey);

    let asrResult;
    try {
      asrResult = await asr.transcribe(base64Audio, {
        language: resolvedLanguage,
        autoDetect: useAutoDetect,
        allowedLanguages: supportedLangs as string[],
        diarization: true,
        timestamps: true,
      });
    } catch (err) {
      // §8 — ASR failure handling
      await supabase.from("call_transcripts").update({ status: "failed" }).eq("id", transcript.id);
      logger.error("transcribe_asr_failed", {
        callSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return respond({ ok: false, error: "ASR transcription failed" }, 500);
    }

    // ---- Diarization normalization (§3) ----
    const normalizedSegments = normalizeSpeakerRoles(
      asrResult.segments,
      session.direction,
    );

    // ---- Transcript cleanup (§4) ----
    const cleanedSegments = cleanSegments(normalizedSegments);

    // ---- Build LLM-ready transcript (§7) ----
    const llmTranscript = formatLlmTranscript(cleanedSegments);

    // Build clean fullText from cleaned segments
    const cleanFullText = cleanedSegments.map((s) => s.text).join(" ");

    // ---- Persist completed transcript ----
    await supabase.from("call_transcripts").update({
      status: "completed",
      segments_json: cleanedSegments,
      full_text: llmTranscript, // LLM-ready formatted version
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

    // ---- Analysis gate (§5) ----
    if (session.duration_sec != null && session.duration_sec < analyzeMin) {
      // Create skipped analysis record
      await supabase.from("call_analyses").insert({
        call_session_id: callSessionId,
        status: "skipped_short",
      });
      logger.info("analyze_skipped_short", {
        callSessionId,
        durationSec: session.duration_sec,
        minRequired: analyzeMin,
      });
    } else {
      // Enqueue analysis
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
