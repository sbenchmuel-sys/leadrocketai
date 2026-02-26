// ============================================================
// Call Analyze — LLM analysis of call transcript
// Produces summary, action items, signals, next steps
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { CALL_DEFAULTS } from "../_shared/callConfig.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ANALYSIS_PROMPT = `You are a sales call analyst. Analyze the following call transcript and return JSON ONLY:

{
  "summaryShort": "1-2 sentence summary",
  "summaryLong": "detailed 3-5 paragraph summary",
  "actionItems": [
    {
      "text": "action description",
      "owner": "person responsible",
      "dueDate": "YYYY-MM-DD or null",
      "evidence": [{"segmentIndex": 0, "speakerLabel": "Speaker 1", "quote": "exact quote <=200 chars"}]
    }
  ],
  "signals": [
    {
      "type": "intent|sentiment|objection|risk|commitment|entity",
      "value": "description",
      "evidence": [{"segmentIndex": 0, "speakerLabel": "Speaker 1", "quote": "exact quote <=200 chars"}]
    }
  ],
  "recommendedNextSteps": [
    {
      "title": "step title",
      "rationale": "why this matters",
      "priority": 1,
      "evidence": [{"segmentIndex": 0, "speakerLabel": "Speaker 1", "quote": "exact quote <=200 chars"}]
    }
  ]
}

Rules:
- Every item MUST include evidence pointers with exact quotes from the transcript
- Quotes must be <=200 characters
- Identify risks, objections, commitments, and buying signals
- Action items should be specific and actionable
- Recommended next steps should be ranked by priority (1 = highest)
- Be thorough but concise

Transcript:
{{TRANSCRIPT}}`;

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
      return new Response(JSON.stringify({ ok: false, error: "Missing callSessionId" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get session + settings
    const { data: session } = await supabase
      .from("call_sessions")
      .select("id, workspace_id, duration_sec, lead_id")
      .eq("id", callSessionId)
      .single();

    if (!session) {
      return new Response(JSON.stringify({ ok: false, error: "Session not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: settings } = await supabase
      .from("call_settings")
      .select("analyze_min_duration_sec")
      .eq("workspace_id", session.workspace_id)
      .maybeSingle();

    const minDuration = settings?.analyze_min_duration_sec ?? CALL_DEFAULTS.ANALYZE_MIN_DURATION_SEC;

    if (session.duration_sec != null && session.duration_sec < minDuration) {
      await supabase.from("call_analyses").insert({
        call_session_id: callSessionId,
        status: "skipped_short",
      });
      return new Response(JSON.stringify({ ok: true, status: "skipped_short" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get latest completed transcript
    const { data: transcript } = await supabase
      .from("call_transcripts")
      .select("id, full_text, segments_json")
      .eq("call_session_id", callSessionId)
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!transcript?.full_text) {
      await supabase.from("call_analyses").insert({
        call_session_id: callSessionId,
        status: "failed",
      });
      return new Response(JSON.stringify({ ok: false, error: "No completed transcript" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create analysis record
    const { data: analysis, error: insertErr } = await supabase
      .from("call_analyses")
      .insert({
        call_session_id: callSessionId,
        status: "processing",
        model: "google/gemini-2.5-flash",
      })
      .select("id")
      .single();

    if (insertErr || !analysis) {
      logger.error("analyze_insert_error", { error: insertErr?.message });
      return new Response(JSON.stringify({ ok: false, error: "Failed to create analysis" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!lovableApiKey) {
      await supabase.from("call_analyses").update({ status: "failed" }).eq("id", analysis.id);
      return new Response(JSON.stringify({ ok: false, error: "LOVABLE_API_KEY not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build transcript text with segment indices for evidence pointers
    let formattedTranscript = "";
    const segments = transcript.segments_json as Array<{ speaker?: string; text?: string }>;
    if (Array.isArray(segments) && segments.length > 0) {
      formattedTranscript = segments
        .map((seg, i) => `[${i}] ${seg.speaker ?? "Unknown"}: ${seg.text ?? ""}`)
        .join("\n");
    } else {
      formattedTranscript = transcript.full_text;
    }

    const prompt = ANALYSIS_PROMPT.replace("{{TRANSCRIPT}}", formattedTranscript);

    const aiResponse = await fetch("https://api.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      await supabase.from("call_analyses").update({ status: "failed" }).eq("id", analysis.id);
      logger.error("analyze_ai_error", { status: aiResponse.status, error: errText });
      return new Response(JSON.stringify({ ok: false, error: "AI analysis failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiResult = await aiResponse.json();
    const content = aiResult.choices?.[0]?.message?.content ?? "";

    let parsed: Record<string, unknown>;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch {
      parsed = {};
    }

    // Update analysis record
    await supabase.from("call_analyses").update({
      status: "completed",
      summary_short: (parsed.summaryShort as string) ?? null,
      summary_long: (parsed.summaryLong as string) ?? null,
      action_items_json: parsed.actionItems ?? [],
      signals_json: parsed.signals ?? {},
      recommended_next_steps_json: parsed.recommendedNextSteps ?? [],
    }).eq("id", analysis.id);

    logger.info("analyze_complete", { callSessionId, analysisId: analysis.id });

    // Bridge to interactions table if lead is linked
    if (session.lead_id) {
      const summary = (parsed.summaryShort as string) ?? "Phone call completed";
      await supabase.from("interactions").insert({
        lead_id: session.lead_id,
        type: "phone_call",
        source: "twilio",
        direction: "inbound",
        body_text: summary,
        subject: `Call ${session.duration_sec ? `(${Math.ceil(session.duration_sec / 60)} min)` : ""}`,
        occurred_at: new Date().toISOString(),
      });
      logger.info("analyze_bridged_to_interactions", { leadId: session.lead_id });
    }

    return new Response(JSON.stringify({ ok: true, analysisId: analysis.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    logger.error("analyze_error", { error: err instanceof Error ? err.message : String(err) });
    return new Response(JSON.stringify({ ok: false, error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
