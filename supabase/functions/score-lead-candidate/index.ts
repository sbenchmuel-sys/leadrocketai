// ============================================================
// score-lead-candidate — AI scoring for the Lead Candidates queue
//
// Picks up to 25 pending candidates with NULL ai_score, sends each
// to the Lovable AI gateway (Gemini Flash Lite), parses a strict
// JSON response, and writes ai_score (0-100) + ai_reason back to
// the row. Decoupled from detect-lead-candidates by design — scoring
// runs on its own 10-min cron, so detection stays fast and scoring
// can be re-tried independently if a call fails.
//
// Auth: X-Internal-Secret (cron-dispatcher) OR service-role token.
// V1: scoring is advisory only — never auto-dismisses. Spec issue #3.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// How many candidates to score per cron tick. Each call ~1-2s; 5 in parallel = ~5-10s total.
const MAX_PER_RUN = 25;
const PARALLELISM = 5;
// Same cheap/fast model the rest of the codebase uses for classification-style tasks
const MODEL = "google/gemini-2.5-flash-lite";

const SCORER_SYSTEM_PROMPT = `You score lead candidates for a B2B sales workspace.

Given a contact and the most recent email exchange, return a 0–100 score plus a one-sentence reason.

Scoring guide:
- 80–100: Strong prospect. Business domain, named contact, real engagement (replies / multiple touches / referral).
- 50–79: Plausible prospect. Business signals but unclear engagement or fit.
- 20–49: Weak. Generic, single touch, thin signal.
- 0–19: Probably not a real lead. Looks like a vendor pitch, automated, role address, or low quality.

Output STRICT JSON only — no markdown fences, no commentary, no extra keys:
{"score": <integer 0-100>, "reason": "<one short sentence>"}`;

interface CandidateRow {
  id: string;
  contact_email: string;
  contact_name: string | null;
  company_domain: string | null;
  source: string;
  email_count: number | null;
  subject_snippet: string | null;
  body_snippet: string | null;
}

interface ScoreResult {
  score: number;
  reason: string;
}

function buildUserPrompt(c: CandidateRow): string {
  const name = c.contact_name?.trim() || "(unknown)";
  const subj = (c.subject_snippet || "").slice(0, 160);
  const body = (c.body_snippet || "").slice(0, 400);
  const sourceLabel: Record<string, string> = {
    outbound: "outbound — rep emailed this contact",
    inbound_explicit: "inbound — they emailed and explicitly mentioned the product",
    inbound_referral: "inbound — they emailed citing a referral",
    lookback_seed: "outbound — surfaced from historical mail (first connect)",
  };

  return [
    `Contact: ${name} <${c.contact_email}>`,
    `Company domain: ${c.company_domain || "(unknown)"}`,
    `Source: ${sourceLabel[c.source] || c.source}`,
    `Email count: ${c.email_count ?? 1}`,
    `Latest subject: "${subj}"`,
    `Latest preview: "${body}"`,
  ].join("\n");
}

function parseScore(raw: string): ScoreResult | null {
  if (!raw) return null;
  // Strip code fences if the model added any despite the instruction
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    const obj = JSON.parse(cleaned);
    const score = Number(obj.score);
    const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
    if (!Number.isFinite(score) || score < 0 || score > 100) return null;
    if (!reason) return null;
    return { score: Math.round(score), reason: reason.slice(0, 500) };
  } catch {
    return null;
  }
}

async function scoreOne(
  candidate: CandidateRow,
  apiKey: string,
): Promise<ScoreResult | { error: string }> {
  const userPrompt = buildUserPrompt(candidate);
  let resp: Response;
  try {
    resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SCORER_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    });
  } catch (err) {
    return { error: `network: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return { error: `gateway ${resp.status}: ${body.slice(0, 200)}` };
  }

  const data = await resp.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content ?? "";
  const parsed = parseScore(content);
  if (!parsed) return { error: `unparseable: ${content.slice(0, 200)}` };
  return parsed;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = requireScheduledCaller(req, corsHeaders);
  if (auth instanceof Response) return auth;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");

  if (!lovableApiKey) {
    return new Response(
      JSON.stringify({ ok: false, error: "LOVABLE_API_KEY not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // deno-lint-ignore no-explicit-any
  const serviceSupabase: any = createClient(supabaseUrl, supabaseServiceKey);
  const startedAt = Date.now();

  // Pull oldest unscored pending candidates first (fairness across workspaces)
  const { data: candidates, error: fetchErr } = await serviceSupabase
    .from("lead_candidates")
    .select("id, contact_email, contact_name, company_domain, source, email_count, subject_snippet, body_snippet")
    .eq("status", "pending")
    .is("ai_score", null)
    .order("first_seen_at", { ascending: true })
    .limit(MAX_PER_RUN);

  if (fetchErr) {
    return new Response(
      JSON.stringify({ ok: false, error: `Fetch failed: ${fetchErr.message}` }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const pool: CandidateRow[] = candidates ?? [];
  if (pool.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, scored: 0, errors: 0, duration_ms: Date.now() - startedAt }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let scoredCount = 0;
  let errorCount = 0;
  const errorSamples: string[] = [];

  // Process in parallel batches
  for (let i = 0; i < pool.length; i += PARALLELISM) {
    const batch = pool.slice(i, i + PARALLELISM);
    const results = await Promise.all(batch.map(c => scoreOne(c, lovableApiKey)));

    for (let j = 0; j < batch.length; j++) {
      const candidate = batch[j];
      const result = results[j];

      if ("error" in result) {
        errorCount++;
        if (errorSamples.length < 3) errorSamples.push(`${candidate.id}: ${result.error}`);
        console.warn(`[score-lead-candidate] ${candidate.id} (${candidate.contact_email}) failed: ${result.error}`);
        continue;
      }

      const { error: updateErr } = await serviceSupabase
        .from("lead_candidates")
        .update({ ai_score: result.score, ai_reason: result.reason })
        .eq("id", candidate.id);

      if (updateErr) {
        errorCount++;
        if (errorSamples.length < 3) errorSamples.push(`${candidate.id}: update ${updateErr.message}`);
        console.error(`[score-lead-candidate] ${candidate.id} update failed:`, updateErr.message);
      } else {
        scoredCount++;
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `[score-lead-candidate] Done in ${durationMs}ms — scored:${scoredCount} errors:${errorCount}/${pool.length}`,
  );

  return new Response(
    JSON.stringify({
      ok: true,
      scored: scoredCount,
      errors: errorCount,
      processed: pool.length,
      duration_ms: durationMs,
      ...(errorSamples.length > 0 ? { error_samples: errorSamples } : {}),
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
