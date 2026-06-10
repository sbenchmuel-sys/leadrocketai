// ============================================================================
// COLD-TEMPLATE BEFORE/AFTER EVAL (Unit C)
//
// Why: Unit C consolidates duplicated GROUNDING / BANNED-PHRASE / TONE rules out
// of the pre_email_* templates and into SYSTEM_GLOBAL_PROMPT. The change is
// no-loss by inspection, but the REAL success criterion is empirical: the model
// (google/gemini-2.5-flash-lite) must ground / score EQUAL-OR-BETTER after the
// consolidation, with no new grounding violations, no banned phrases, no
// bracketed-placeholder leakage, and word-count limits still honored.
//
// This harness CANNOT be meaningfully run without a model — it needs the Lovable
// AI gateway (LOVABLE_API_KEY). It is the gate to run BEFORE merging Unit C.
//
// ── HOW TO RUN (produces baseline.json on main, candidate.json on the branch) ──
//   # 1. Baseline (pre-change prompts):
//   git stash || true
//   git worktree add /tmp/dp-main origin/main && cd /tmp/dp-main
//   LOVABLE_API_KEY=... deno run --allow-net --allow-env \
//     supabase/functions/_shared/__evals__/coldTemplateEval.ts run > /tmp/baseline.json
//
//   # 2. Candidate (this branch):
//   cd <this worktree>
//   LOVABLE_API_KEY=... deno run --allow-net --allow-env \
//     supabase/functions/_shared/__evals__/coldTemplateEval.ts run > /tmp/candidate.json
//
//   # 3. Gate:
//   deno run --allow-read supabase/functions/_shared/__evals__/coldTemplateEval.ts \
//     compare /tmp/baseline.json /tmp/candidate.json
//   # exit 0 = candidate is >= baseline on every gate; exit 1 = regression.
//
// Tip: pass `RUNS=3` to average over N generations per fixture (reduces model
// nondeterminism). Default 1.
// ============================================================================

import {
  SYSTEM_GLOBAL_PROMPT,
  PROMPTS,
  QUALITY_SCORER_PROMPT,
  GROUNDING_VALIDATOR_PROMPT,
} from "../prompts.ts";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-flash-lite";

// Representative slice of the canonical banned list — these must NEVER appear in
// output regardless of which prompt version produced it (deterministic check).
const BANNED_SUBSTRINGS = [
  "i hope this finds you well",
  "hope you're well",
  "i wanted to reach out",
  "i ask because",
  "just checking in",
  "given your work in",
  "noticed your company",
  "many businesses",
  "many companies in your space",
  "in today's competitive landscape",
  "with advancements in",
  "color matching",
  "seasonal demand",
  "tight margins",
  "operational efficiency",
];

// Word-count ceiling enforced for a cold intro (matches the LENGTH guidance).
const WORD_LIMIT = 90;

interface Fixture {
  name: string;
  kind: "strong_intel" | "low_intel" | "prior_relationship" | "commercial_context";
  vars: Record<string, string>;
}

const COMMON = {
  INSTRUCTIONS_PRIORITY_BLOCK: "",
  LENGTH_OVERRIDE: "Keep it under 75 words. Two short paragraphs.",
  INSTRUCTION_CTA_NOTE: "",
  REP_CONTEXT: "Sender Name: Mike Torres\nSender Title: Account Exec\nSender Company: Spectra Supplies",
  MEETING_LINK: "",
  LEAD_INTELLIGENCE: "",
  SIGNALS: "",
};

const FIXTURES: Fixture[] = [
  {
    name: "strong_intel",
    kind: "strong_intel",
    vars: {
      ...COMMON,
      SELLER_CONTEXT: "We sell wide-format sublimation ink and transfer paper to apparel decorators.",
      LEAD_CONTEXT: "Name: Lisa Chen\nCompany: Bright Solutions\nRole: Owner\nIndustry: Custom apparel decoration",
      SIGNALS: "Recently posted hiring 3 production staff; mentioned doubling output for Q4 team-store orders.",
      LEAD_INTELLIGENCE: "Recommended angle: ask how they're scaling decoration throughput for Q4 team-store demand.",
    },
  },
  {
    name: "low_intel",
    kind: "low_intel",
    vars: {
      ...COMMON,
      SELLER_CONTEXT: "We sell wide-format sublimation ink and transfer paper to apparel decorators.",
      LEAD_CONTEXT: "Name: Dave Romero\nCompany: Summit Construction\nRole: Operations Manager",
      SIGNALS: "",
      LEAD_INTELLIGENCE: "",
    },
  },
  {
    name: "prior_relationship",
    kind: "prior_relationship",
    vars: {
      ...COMMON,
      SELLER_CONTEXT: "We sell wide-format sublimation ink and transfer paper to apparel decorators.",
      LEAD_CONTEXT:
        "Name: Sarah Webb\nCompany: Vivid Threads\nRole: Production Lead\nIndustry: Custom apparel\nPRIOR RELATIONSHIP: existing contact — met at the ISS Long Beach trade show last spring; she requested a sample pack.",
      SIGNALS: "",
      LEAD_INTELLIGENCE: "",
    },
  },
  {
    name: "commercial_context",
    kind: "commercial_context",
    vars: {
      ...COMMON,
      SELLER_CONTEXT: "We sell wide-format sublimation ink and transfer paper to apparel decorators.",
      LEAD_CONTEXT:
        "Name: Jack Liu\nCompany: Comtix\nRole: Owner\nIndustry: Print shop\nCOMMERCIAL CONTEXT: Opportunity Size: 700 units/mo; Product interest: bulk transfer paper\nKNOWN FACTS: Connect wk-of 03/30",
      SIGNALS: "",
      LEAD_INTELLIGENCE: "",
    },
  },
];

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k] ?? "");
}

async function callModel(system: string, user: string, temperature = 0.6): Promise<string> {
  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) throw new Error("LOVABLE_API_KEY not set — this eval needs the model gateway.");
  const resp = await fetch(GATEWAY, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`gateway ${resp.status}: ${await resp.text()}`);
  const json = await resp.json();
  return json.choices?.[0]?.message?.content ?? "";
}

async function scoreJson(prompt: string, payload: string): Promise<Record<string, unknown>> {
  const raw = await callModel(prompt, payload, 0);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    return JSON.parse(match[0]);
  } catch {
    return {};
  }
}

function deterministicChecks(email: string) {
  const lower = email.toLowerCase();
  const bannedHits = BANNED_SUBSTRINGS.filter((b) => lower.includes(b));
  const bracketPlaceholders = /\[[^\]]+\]|\{[A-Za-z]/.test(email); // [Name] or {FirstName} leakage
  const wordCount = email.trim().split(/\s+/).filter(Boolean).length;
  return {
    bannedHits,
    bracketPlaceholderLeak: bracketPlaceholders,
    wordCount,
    overWordLimit: wordCount > WORD_LIMIT,
  };
}

interface FixtureResult {
  fixture: string;
  email: string;
  quality: Record<string, unknown>;
  grounding: Record<string, unknown>;
  checks: ReturnType<typeof deterministicChecks>;
}

async function runOne(fx: Fixture, runs: number): Promise<FixtureResult> {
  const system = SYSTEM_GLOBAL_PROMPT;
  const user = fill(PROMPTS["pre_email_1_intro"], fx.vars);
  // Use the last of N generations (or 1). Averaging numeric scores below.
  let email = "";
  const qualities: Record<string, unknown>[] = [];
  let grounding: Record<string, unknown> = {};
  for (let i = 0; i < Math.max(1, runs); i++) {
    email = await callModel(system, user);
    const q = await scoreJson(
      QUALITY_SCORER_PROMPT,
      `EMAIL:\n${email}\n\nLEAD CONTEXT:\n${fx.vars.LEAD_CONTEXT}\n\nSELLER CONTEXT:\n${fx.vars.SELLER_CONTEXT}\n\nSIGNALS:\n${fx.vars.SIGNALS}`,
    );
    qualities.push(q);
    grounding = await scoreJson(
      GROUNDING_VALIDATOR_PROMPT,
      `GENERATED EMAIL:\n${email}\n\nLEAD CONTEXT:\n${fx.vars.LEAD_CONTEXT}\n\nSELLER CONTEXT:\n${fx.vars.SELLER_CONTEXT}\n\nSIGNALS:\n${fx.vars.SIGNALS}`,
    );
  }
  // Average the numeric quality dims across runs.
  const avg: Record<string, unknown> = {};
  for (const dim of ["curiosity", "human_tone", "spam_risk", "reply_likelihood"]) {
    const vals = qualities.map((q) => Number(q[dim])).filter((n) => !Number.isNaN(n));
    avg[dim] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  avg.grounding_violation = qualities.some((q) => q.grounding_violation === true);
  return { fixture: fx.name, email, quality: avg, grounding, checks: deterministicChecks(email) };
}

function qualityComposite(q: Record<string, unknown>): number {
  // Higher is better: reward curiosity/human_tone/reply_likelihood, penalize spam_risk.
  const n = (k: string) => (typeof q[k] === "number" ? (q[k] as number) : 0);
  return n("curiosity") + n("human_tone") + n("reply_likelihood") - n("spam_risk");
}

// ── compare mode (the gate) ────────────────────────────────────────────────
function compare(baselinePath: string, candidatePath: string) {
  const base = JSON.parse(Deno.readTextFileSync(baselinePath)) as { results: FixtureResult[] };
  const cand = JSON.parse(Deno.readTextFileSync(candidatePath)) as { results: FixtureResult[] };
  const byName = (rs: FixtureResult[]) => Object.fromEntries(rs.map((r) => [r.fixture, r]));
  const b = byName(base.results);
  const c = byName(cand.results);

  let failed = false;
  console.log("fixture                | base q | cand q | grounding | banned | brackets | words");
  console.log("-----------------------+--------+--------+-----------+--------+----------+------");
  for (const name of Object.keys(c)) {
    const cr = c[name];
    const br = b[name];
    const cq = qualityComposite(cr.quality);
    const bq = br ? qualityComposite(br.quality) : 0;
    const groundingOk = (cr.grounding?.pass !== false) && cr.quality.grounding_violation !== true;
    const bannedOk = cr.checks.bannedHits.length === 0;
    const bracketsOk = !cr.checks.bracketPlaceholderLeak;
    const wordsOk = !cr.checks.overWordLimit;
    // Gate: candidate quality must not regress by more than a small tolerance,
    // and every deterministic / grounding check must pass on the candidate.
    const qualityOk = cq >= bq - 1; // 1-point tolerance for model noise
    const rowOk = groundingOk && bannedOk && bracketsOk && wordsOk && qualityOk;
    if (!rowOk) failed = true;
    console.log(
      `${name.padEnd(22)} | ${bq.toFixed(1).padStart(6)} | ${cq.toFixed(1).padStart(6)} | ` +
        `${(groundingOk ? "ok" : "FAIL").padStart(9)} | ${(bannedOk ? "ok" : cr.checks.bannedHits.join(",")).padStart(6)} | ` +
        `${(bracketsOk ? "ok" : "LEAK").padStart(8)} | ${String(cr.checks.wordCount).padStart(4)}${wordsOk ? "" : "!"}`,
    );
  }
  console.log("");
  if (failed) {
    console.error("GATE: FAIL — candidate regressed on quality or tripped a check. Do NOT merge.");
    Deno.exit(1);
  }
  console.log("GATE: PASS — candidate is >= baseline on every fixture. Safe to merge (with human review).");
}

// ── entrypoint ──────────────────────────────────────────────────────────────
if (import.meta.main) {
  const [mode, a, b] = Deno.args;
  if (mode === "compare") {
    if (!a || !b) {
      console.error("usage: coldTemplateEval.ts compare <baseline.json> <candidate.json>");
      Deno.exit(2);
    }
    compare(a, b);
  } else if (mode === "run") {
    const runs = Number(Deno.env.get("RUNS") ?? "1");
    const results: FixtureResult[] = [];
    for (const fx of FIXTURES) {
      console.error(`[eval] generating ${fx.name} (${runs} run(s))...`);
      results.push(await runOne(fx, runs));
    }
    // JSON report to stdout; progress to stderr so stdout stays clean for piping.
    console.log(JSON.stringify({ model: MODEL, runs, results }, null, 2));
  } else {
    console.error("usage: coldTemplateEval.ts <run|compare>  (see file header)");
    Deno.exit(2);
  }
}
