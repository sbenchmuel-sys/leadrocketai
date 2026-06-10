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
// ── HOW TO RUN ────────────────────────────────────────────────────────────────
// The harness only exists on THIS branch, so it evaluates BOTH versions by
// pointing PROMPTS_MODULE at whichever prompts.ts you want (the harness itself is
// always run from this branch — no need for it to exist on main).
//
//   # 0. Check out main's prompts beside this worktree (for the baseline source):
//   git worktree add /tmp/dp-main origin/main
//
//   # 1. Baseline (main's prompts.ts, harness from THIS branch):
//   PROMPTS_MODULE="file:///tmp/dp-main/supabase/functions/_shared/prompts.ts" \
//   LOVABLE_API_KEY=... deno run --allow-net --allow-env --allow-read \
//     supabase/functions/_shared/__evals__/coldTemplateEval.ts run > /tmp/baseline.json
//
//   # 2. Candidate (this branch's prompts.ts — the default source):
//   LOVABLE_API_KEY=... deno run --allow-net --allow-env --allow-read \
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

// The prompts source is PARAMETERIZED so the SAME harness (which only exists on
// this branch) can evaluate BOTH the candidate (this branch's prompts.ts) and the
// baseline (main's prompts.ts) — point PROMPTS_MODULE at a main worktree's
// prompts.ts for the baseline run. Defaults to this branch's prompts.ts.
const PROMPTS_MODULE = Deno.env.get("PROMPTS_MODULE") ??
  new URL("../prompts.ts", import.meta.url).href;
const promptsMod = await import(PROMPTS_MODULE);
const SYSTEM_GLOBAL_PROMPT = promptsMod.SYSTEM_GLOBAL_PROMPT as string;
const PROMPTS = promptsMod.PROMPTS as Record<string, string>;
const QUALITY_SCORER_PROMPT = promptsMod.QUALITY_SCORER_PROMPT as string;
const GROUNDING_VALIDATOR_PROMPT = promptsMod.GROUNDING_VALIDATOR_PROMPT as string;

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-flash-lite";

// The COMPLETE canonical banned list (mirrors SYSTEM_GLOBAL_PROMPT's BANNED
// PHRASES + the STRICT KB generic-pain-points) — these must NEVER appear in output
// regardless of which prompt version produced it. Matched on word boundaries so
// "I hear" does not false-positive on "I heard". ("What if" is banned only as an
// OPENER and is checked separately below.)
const BANNED_PHRASES = [
  "i hope this finds you well",
  "hope you're well",
  "i wanted to reach out",
  "hope you had a good week",
  "i ask because",
  "just checking in",
  "i hear",
  "given your work in",
  "noticed your company",
  "are you exploring",
  "many businesses",
  "many companies in your space",
  "many printing businesses",
  "in today's competitive landscape",
  "with advancements in",
  "color matching",
  "seasonal demand",
  "tight margins",
  "operational efficiency",
];
const BANNED_REGEXES = BANNED_PHRASES.map(
  (p) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
);

// Word-count ceiling enforced for a cold intro (matches the LENGTH guidance).
const WORD_LIMIT = 90;

interface Fixture {
  name: string;
  kind: "strong_intel" | "low_intel" | "prior_relationship" | "commercial_context" | "followup";
  // Which cold template this fixture exercises. Every template Unit C changed
  // (pre_email_1_intro, pre_email_2_followup, pre_email_3_followup) must be
  // covered so a regression in any of them can fail the gate.
  template: "pre_email_1_intro" | "pre_email_2_followup" | "pre_email_3_followup";
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
    template: "pre_email_1_intro",
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
    template: "pre_email_1_intro",
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
    template: "pre_email_1_intro",
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
    template: "pre_email_1_intro",
    vars: {
      ...COMMON,
      SELLER_CONTEXT: "We sell wide-format sublimation ink and transfer paper to apparel decorators.",
      LEAD_CONTEXT:
        "Name: Jack Liu\nCompany: Comtix\nRole: Owner\nIndustry: Print shop\nCOMMERCIAL CONTEXT: Opportunity Size: 700 units/mo; Product interest: bulk transfer paper\nKNOWN FACTS: Connect wk-of 03/30",
      SIGNALS: "",
      LEAD_INTELLIGENCE: "",
    },
  },
  {
    name: "followup_2",
    kind: "followup",
    template: "pre_email_2_followup",
    vars: {
      ...COMMON,
      LEAD_CONTEXT: "Name: Jack Liu\nCompany: Comtix\nRole: Owner\nIndustry: Print shop",
      PREVIOUS_EMAIL_SUMMARY: "Asked whether reprints were their biggest margin drain heading into peak season.",
      LAST_OUTBOUND_BODY: "Hi Jack,\n\nSaw Comtix runs a busy print shop. Quick one — are reprints still the biggest margin killer for shops your size?\n\nBest,\nMike",
      KNOWLEDGE_CONTEXT: "Case: print shops using digital proofing cut reprint costs ~20%.",
    },
  },
  {
    name: "followup_3",
    kind: "followup",
    template: "pre_email_3_followup",
    vars: {
      ...COMMON,
      LEAD_CONTEXT: "Name: Jack Liu\nCompany: Comtix\nRole: Owner\nIndustry: Print shop",
      PREVIOUS_EMAIL_SUMMARY: "Two prior notes: peak-season reprints, then a question on in-house vs outsourced decoration.",
      LAST_OUTBOUND_BODY: "Hi Jack,\n\nDropped you a line about reprint costs. Curious — are you handling proofing in-house or outsourcing?\n\nBest,\nMike",
      KNOWLEDGE_CONTEXT: "Case: print shops using digital proofing cut reprint costs ~20%.",
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
  const bannedHits = BANNED_PHRASES.filter((_p, i) => BANNED_REGEXES[i].test(email));
  // "What if" is banned specifically as an OPENER — flag only when the body opens
  // with it (strip a leading "Subject:" line and greeting first).
  const body = email
    .replace(/^\s*(?:subject:[^\n]*\n+)?(?:hi|hey|hello|dear)[^\n]*\n+/i, "")
    .trimStart();
  if (/^what if\b/i.test(body)) bannedHits.push("what if (opener)");
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
  const user = fill(PROMPTS[fx.template], fx.vars);
  // Evidence the scorers must see — INCLUDE Knowledge Context so KB-grounded
  // sentences (e.g. a follow-up's "~20% proofing" insight) are judged WITH the
  // evidence they came from, not falsely flagged as ungrounded.
  const evidence =
    `LEAD CONTEXT:\n${fx.vars.LEAD_CONTEXT ?? ""}\n\n` +
    `SELLER CONTEXT:\n${fx.vars.SELLER_CONTEXT ?? ""}\n\n` +
    `SIGNALS:\n${fx.vars.SIGNALS ?? ""}\n\n` +
    `KNOWLEDGE CONTEXT:\n${fx.vars.KNOWLEDGE_CONTEXT ?? ""}`;

  const emails: string[] = [];
  const qualities: Record<string, unknown>[] = [];
  const groundings: Record<string, unknown>[] = [];
  const perRunChecks: ReturnType<typeof deterministicChecks>[] = [];
  for (let i = 0; i < Math.max(1, runs); i++) {
    const email = await callModel(system, user);
    emails.push(email);
    perRunChecks.push(deterministicChecks(email));
    qualities.push(await scoreJson(QUALITY_SCORER_PROMPT, `EMAIL:\n${email}\n\n${evidence}`));
    groundings.push(await scoreJson(GROUNDING_VALIDATOR_PROMPT, `GENERATED EMAIL:\n${email}\n\n${evidence}`));
  }
  // Average the numeric quality dims; grounding_violation = true if ANY run flagged.
  const avg: Record<string, unknown> = {};
  for (const dim of ["curiosity", "human_tone", "spam_risk", "reply_likelihood"]) {
    const vals = qualities.map((q) => Number(q[dim])).filter((n) => !Number.isNaN(n));
    avg[dim] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  avg.grounding_violation = qualities.some((q) => q.grounding_violation === true);

  // Aggregate WORST-CASE deterministic checks + grounding across ALL runs, so a
  // banned phrase / placeholder / over-limit / validator failure in any earlier
  // generation can't be masked by a clean final sample under RUNS>1.
  const aggChecks = {
    bannedHits: [...new Set(perRunChecks.flatMap((c) => c.bannedHits))],
    bracketPlaceholderLeak: perRunChecks.some((c) => c.bracketPlaceholderLeak),
    wordCount: Math.max(...perRunChecks.map((c) => c.wordCount)),
    overWordLimit: perRunChecks.some((c) => c.overWordLimit),
  };
  // The validator fails a run when EITHER pass===false OR safe_to_send===false
  // (mirrors the production grounding gate). aggGrounding.pass is true only if
  // every run is both passing AND safe.
  const runUnsafe = (g: Record<string, unknown>) => g.pass === false || g.safe_to_send === false;
  const aggGrounding: Record<string, unknown> = {
    pass: !groundings.some(runUnsafe),
    runs_failed: groundings.filter(runUnsafe).length,
  };
  // Representative email: surface a failing generation if any, else the last.
  const failIdx = perRunChecks.findIndex(
    (c) => c.bannedHits.length > 0 || c.bracketPlaceholderLeak || c.overWordLimit,
  );
  const email = emails[failIdx >= 0 ? failIdx : emails.length - 1];
  return { fixture: fx.name, email, quality: avg, grounding: aggGrounding, checks: aggChecks };
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
