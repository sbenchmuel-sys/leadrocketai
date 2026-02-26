// ============================================================
// Call Transcribe — Uses Lovable AI to transcribe audio
// Then enqueues analysis if duration meets threshold
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
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const { callSessionId, recordingId } = await req.json();

    if (!callSessionId) {
      return new Response(JSON.stringify({ ok: false, error: "Missing callSessionId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch recording + session
    const { data: session } = await supabase
      .from("call_sessions")
      .select("id, workspace_id, duration_sec")
      .eq("id", callSessionId)
      .single();

    if (!session) {
      return new Response(JSON.stringify({ ok: false, error: "Session not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get call settings for workspace
    const { data: settings } = await supabase
      .from("call_settings")
      .select("*")
      .eq("workspace_id", session.workspace_id)
      .maybeSingle();

    const minDuration = settings?.transcribe_min_duration_sec ?? CALL_DEFAULTS.TRANSCRIBE_MIN_DURATION_SEC;
    const language = settings?.default_language ?? CALL_DEFAULTS.DEFAULT_LANGUAGE;

    // Check duration threshold
    if (session.duration_sec != null && session.duration_sec < minDuration) {
      await supabase.from("call_transcripts").insert({
        call_session_id: callSessionId,
        status: "skipped_short",
        language,
        provider: "none",
      });

      logger.info("transcribe_skipped_short", { callSessionId, durationSec: session.duration_sec });
      return new Response(JSON.stringify({ ok: true, status: "skipped_short" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create transcript record as processing
    const { data: transcript, error: insertErr } = await supabase
      .from("call_transcripts")
      .insert({
        call_session_id: callSessionId,
        status: "processing",
        language,
        provider: "lovable-ai",
      })
      .select("id")
      .single();

    if (insertErr || !transcript) {
      logger.error("transcribe_insert_error", { error: insertErr?.message });
      return new Response(JSON.stringify({ ok: false, error: "Failed to create transcript" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get the recording audio from storage
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
      return new Response(JSON.stringify({ ok: false, error: "No downloaded recording" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Use Lovable AI (Gemini) for transcription via audio understanding
    if (!lovableApiKey) {
      await supabase.from("call_transcripts").update({ status: "failed" }).eq("id", transcript.id);
      logger.error("transcribe_no_api_key", { callSessionId });
      return new Response(JSON.stringify({ ok: false, error: "LOVABLE_API_KEY not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Download audio from storage for sending to AI
    const storagePath = recording.storage_url.split("/storage/v1/object/")[1];
    const { data: audioData, error: dlErr } = await supabase.storage
      .from("call-recordings")
      .download(storagePath?.replace("call-recordings/", "") ?? "");

    if (dlErr || !audioData) {
      await supabase.from("call_transcripts").update({ status: "failed" }).eq("id", transcript.id);
      logger.error("transcribe_download_error", { error: dlErr?.message });
      return new Response(JSON.stringify({ ok: false, error: "Failed to download audio" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Convert audio to base64 for Gemini multimodal
    const audioBuffer = await audioData.arrayBuffer();
    const base64Audio = btoa(String.fromCharCode(...new Uint8Array(audioBuffer)));

    const aiResponse = await fetch("https://api.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: {
                  data: base64Audio,
                  format: "wav",
                },
              },
              {
                type: "text",
                text: `Transcribe this phone call audio in ${language}. Return JSON ONLY with this structure:
{
  "segments": [
    {"startMs": 0, "endMs": 5000, "speaker": "Speaker 1", "text": "..."},
    {"startMs": 5000, "endMs": 10000, "speaker": "Speaker 2", "text": "..."}
  ],
  "fullText": "complete transcript as single string",
  "confidence": 0.95,
  "language": "${language}"
}
Identify different speakers. Be accurate with timestamps. Return valid JSON only.`,
              },
            ],
          },
        ],
        temperature: 0.1,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      await supabase.from("call_transcripts").update({ status: "failed" }).eq("id", transcript.id);
      logger.error("transcribe_ai_error", { status: aiResponse.status, error: errText });
      return new Response(JSON.stringify({ ok: false, error: "AI transcription failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiResult = await aiResponse.json();
    const content = aiResult.choices?.[0]?.message?.content ?? "";

    // Parse AI response
    let parsed: { segments?: unknown[]; fullText?: string; confidence?: number };
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch {
      parsed = { fullText: content, segments: [], confidence: null };
    }

    // Update transcript
    await supabase.from("call_transcripts").update({
      status: "completed",
      segments_json: parsed.segments ?? [],
      full_text: parsed.fullText ?? content,
      confidence: parsed.confidence ?? null,
    }).eq("id", transcript.id);

    logger.info("transcribe_complete", {
      callSessionId,
      transcriptId: transcript.id,
      segmentCount: (parsed.segments ?? []).length,
    });

    // Enqueue analysis if duration meets threshold
    const analyzeMin = settings?.analyze_min_duration_sec ?? CALL_DEFAULTS.ANALYZE_MIN_DURATION_SEC;
    if (session.duration_sec == null || session.duration_sec >= analyzeMin) {
      await enqueueCallJob({
        type: "analyze_call",
        callSessionId,
      });
    }

    return new Response(JSON.stringify({ ok: true, transcriptId: transcript.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    logger.error("transcribe_error", { error: err instanceof Error ? err.message : String(err) });
    return new Response(JSON.stringify({ ok: false, error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
