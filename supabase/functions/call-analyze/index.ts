// ============================================================
// Call Analyze — Phase 4: Intelligence Layer
// Structured signal extraction with evidence linking,
// confidence scoring, sentiment timeline, retry logic
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { CALL_DEFAULTS } from "../_shared/callConfig.ts";

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

// ---- Phase 4: Deterministic analysis prompt ----
function buildAnalysisPrompt(
  transcript: string,
  direction: string,
  durationSec: number | null,
): string {
  const durationStr = durationSec ? `${Math.ceil(durationSec / 60)} minutes` : "unknown";

  return `You are an expert sales call analyst. Analyze the transcript below and return STRICT JSON only.
Do NOT wrap in markdown. Do NOT add commentary outside the JSON object.

CALL METADATA:
- Direction: ${direction}
- Duration: ${durationStr}

OUTPUT SCHEMA (return exactly this structure):
{
  "summaryShort": "1-2 sentence summary of the call",
  "summaryLong": "3-5 paragraph detailed summary",
  "outcome": {
    "label": "positive|neutral|negative|no_outcome",
    "confidence": 0.0-1.0
  },
  "intent": {
    "type": "buying|support|complaint|renewal|churn_risk|other",
    "confidence": 0.0-1.0,
    "evidence": [{"timestamp": "MM:SS", "speaker": "Agent|Customer", "quote": "exact short quote"}]
  },
  "sentiment": {
    "overall": "positive|neutral|negative",
    "confidence": 0.0-1.0,
    "timeline": [
      {"minute": 0, "sentiment": "neutral"}
    ]
  },
  "objections": [
    {
      "type": "price|timing|security|feature_gap|trust|other",
      "severity": "low|medium|high",
      "evidence": [{"timestamp": "MM:SS", "speaker": "Customer", "quote": "exact short quote"}]
    }
  ],
  "commitments": [
    {
      "who": "Agent|Customer",
      "text": "commitment description",
      "dueDate": "YYYY-MM-DD or null",
      "evidence": [{"timestamp": "MM:SS", "speaker": "Agent|Customer", "quote": "exact short quote"}]
    }
  ],
  "risks": [
    {
      "type": "churn|legal|escalation|no_next_step|other",
      "severity": "low|medium|high",
      "evidence": [{"timestamp": "MM:SS", "speaker": "Agent|Customer", "quote": "exact short quote"}]
    }
  ],
  "actionItems": [
    {
      "text": "action description",
      "owner": "Agent|Internal|Customer",
      "priority": "low|medium|high",
      "evidence": [{"timestamp": "MM:SS", "speaker": "Agent|Customer", "quote": "exact short quote"}]
    }
  ],
  "recommendedNextSteps": [
    {
      "rank": 1,
      "text": "specific next step",
      "rationale": "why this matters given the call context",
      "confidence": 0.0-1.0,
      "evidence": [{"timestamp": "MM:SS", "speaker": "Agent|Customer", "quote": "exact short quote"}]
    }
  ]
}

RULES:
- Return STRICT JSON only. No markdown fences, no extra text.
- Every structured item MUST include evidence with exact quotes from the transcript.
- Quotes must be <=200 characters and reference actual words spoken.
- Do NOT invent facts not present in the transcript.
- If unsure about a classification, lower the confidence score.
- Sentiment timeline: divide the call into minute blocks (0, 1, 2...).
- recommendedNextSteps: rank top 3 max, avoid generic advice, reference commitments & objections.
- If no objections/risks/commitments found, use empty arrays [].
- All confidence values must be between 0.0 and 1.0.

TRANSCRIPT:
${transcript}`;
}

// ---- JSON extraction with repair ----
function extractJson(raw: string): Record<string, unknown> | null {
  // Strip markdown fences
  let cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "");

  // Find outermost JSON object
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

  cleaned = cleaned.substring(firstBrace, lastBrace + 1);

  // Basic repairs
  cleaned = cleaned
    .replace(/[\x00-\x1F\x7F]/g, " ") // control chars
    .replace(/,\s*([}\]])/g, "$1");     // trailing commas

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// ---- Validate required top-level keys ----
const REQUIRED_KEYS = [
  "summaryShort", "summaryLong", "outcome", "intent",
  "sentiment", "actionItems", "recommendedNextSteps",
];

function validateAnalysisOutput(parsed: Record<string, unknown>): boolean {
  return REQUIRED_KEYS.every((k) => k in parsed);
}

// ---- Default empty output for missing fields ----
function normalizeOutput(parsed: Record<string, unknown>): Record<string, unknown> {
  return {
    summaryShort: parsed.summaryShort ?? "",
    summaryLong: parsed.summaryLong ?? "",
    outcome: parsed.outcome ?? { label: "no_outcome", confidence: 0 },
    intent: parsed.intent ?? { type: "other", confidence: 0, evidence: [] },
    sentiment: parsed.sentiment ?? { overall: "neutral", confidence: 0, timeline: [] },
    objections: parsed.objections ?? [],
    commitments: parsed.commitments ?? [],
    risks: parsed.risks ?? [],
    actionItems: parsed.actionItems ?? [],
    recommendedNextSteps: parsed.recommendedNextSteps ?? [],
  };
}

// ---- Main handler ----
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

    // Get session + settings
    const { data: session } = await supabase
      .from("call_sessions")
      .select("id, workspace_id, duration_sec, lead_id, direction")
      .eq("id", callSessionId)
      .single();

    if (!session) {
      return respond({ ok: false, error: "Session not found" }, 404);
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
      return respond({ ok: true, status: "skipped_short" });
    }

    // Get latest completed transcript (prefer llm_formatted_text)
    const { data: transcript } = await supabase
      .from("call_transcripts")
      .select("id, full_text, llm_formatted_text, segments_json")
      .eq("call_session_id", callSessionId)
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const transcriptText = transcript?.llm_formatted_text || transcript?.full_text;

    if (!transcriptText) {
      await supabase.from("call_analyses").insert({
        call_session_id: callSessionId,
        status: "failed",
      });
      return respond({ ok: false, error: "No completed transcript" }, 404);
    }

    // Idempotent insert (unique constraint on call_session_id)
    const { data: analysis, error: insertErr } = await supabase
      .from("call_analyses")
      .insert({
        call_session_id: callSessionId,
        status: "processing",
        model: "google/gemini-2.5-flash",
        version: "phase4",
      })
      .select("id")
      .single();

    if (insertErr) {
      if (insertErr.code === "23505") {
        logger.info("analyze_already_exists", { callSessionId });
        return respond({ ok: true, status: "already_exists" });
      }
      logger.error("analyze_insert_error", { error: insertErr.message });
      return respond({ ok: false, error: "Failed to create analysis" }, 500);
    }

    if (!lovableApiKey) {
      await supabase.from("call_analyses").update({ status: "failed" }).eq("id", analysis.id);
      return respond({ ok: false, error: "LOVABLE_API_KEY not configured" }, 500);
    }

    const prompt = buildAnalysisPrompt(
      transcriptText,
      session.direction ?? "unknown",
      session.duration_sec,
    );

    // ---- LLM call with retry ----
    let parsed: Record<string, unknown> | null = null;
    const MAX_ATTEMPTS = 2;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const aiResponse = await fetch("https://api.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
        }),
      });

      if (!aiResponse.ok) {
        const errText = await aiResponse.text();
        logger.error("analyze_ai_error", { attempt, status: aiResponse.status, error: errText });
        if (attempt === MAX_ATTEMPTS) {
          await supabase.from("call_analyses").update({ status: "failed" }).eq("id", analysis.id);
          return respond({ ok: false, error: "AI analysis failed" }, 500);
        }
        continue;
      }

      const aiResult = await aiResponse.json();
      const content = aiResult.choices?.[0]?.message?.content ?? "";

      parsed = extractJson(content);

      if (parsed && validateAnalysisOutput(parsed)) {
        break;
      }

      logger.warn("analyze_json_invalid", { attempt, hasKeys: parsed ? Object.keys(parsed) : "null" });
      parsed = null;

      if (attempt === MAX_ATTEMPTS) {
        await supabase.from("call_analyses").update({ status: "failed" }).eq("id", analysis.id);
        return respond({ ok: false, error: "Failed to parse analysis JSON after retries" }, 500);
      }
    }

    if (!parsed) {
      await supabase.from("call_analyses").update({ status: "failed" }).eq("id", analysis.id);
      return respond({ ok: false, error: "No valid analysis output" }, 500);
    }

    const normalized = normalizeOutput(parsed);

    // Update analysis record — store full structured output in signals_json
    await supabase.from("call_analyses").update({
      status: "completed",
      summary_short: (normalized.summaryShort as string) || null,
      summary_long: (normalized.summaryLong as string) || null,
      action_items_json: normalized.actionItems,
      signals_json: normalized, // Full Phase 4 output for cross-channel queries
      recommended_next_steps_json: normalized.recommendedNextSteps,
    }).eq("id", analysis.id);

    logger.info("analyze_complete", { callSessionId, analysisId: analysis.id, version: "phase4" });

    // Bridge to interactions table if lead is linked
    if (session.lead_id) {
      const summary = (normalized.summaryShort as string) || "Phone call completed";
      await supabase.from("interactions").insert({
        lead_id: session.lead_id,
        type: "phone_call",
        source: "twilio",
        direction: session.direction ?? "inbound",
        body_text: summary,
        subject: `Call ${session.duration_sec ? `(${Math.ceil(session.duration_sec / 60)} min)` : ""}`,
        occurred_at: new Date().toISOString(),
      });
      logger.info("analyze_bridged_to_interactions", { leadId: session.lead_id });
    }

    return respond({ ok: true, analysisId: analysis.id });
  } catch (err) {
    logger.error("analyze_error", { error: err instanceof Error ? err.message : String(err) });
    return respond({ ok: false, error: "Internal error" }, 500);
  }
});
