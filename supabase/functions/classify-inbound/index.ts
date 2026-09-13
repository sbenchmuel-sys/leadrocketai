// ============================================================
// classify-inbound — Phase 2a AI classifier cron
//
// Picks up `lead_timeline_items` rows where:
//   • event_type = 'email_inbound'
//   • intent IS NULL
// and classifies each — FIRST with the deterministic detector chain
// (`_shared/inboundIntentDetectors.ts`), and only when that finds
// nothing via `ai_task.intent_router`, writing the
// returned `intent_primary` to `intent`, the returned `ai_summary` to
// `metadata_json.ai_summary` (atomically — see below), and the current
// `INTENT_VERSION` to `intent_version`.
//
// ai_summary is the durable, paraphrased counterpart to `snippet_text`
// that survives the 72h body purge (see CLAUDE.md "Public product
// commitments" + migration `_purge_gate_classified`). Reply-drafting
// context builders (`build-lead-context`, `ai_task` offer dedup) prefer
// `ai_summary` over `snippet_text` so reply quality doesn't degrade
// after purge.
//
// Atomic-or-nothing write: intent + ai_summary are written in a SINGLE
// UPDATE. If parsing of EITHER field fails (malformed JSON, missing
// field, out-of-vocab intent), we leave the row's `intent` NULL so the
// next tick retries. This avoids the "intent written, ai_summary
// missing, row marked classified so never retried" failure mode.
//
// Cron-driven (every 60 seconds via cron-dispatcher). NOT inlined
// into gmail-sync / outlook-sync / outlook-webhook — that decision
// is captured in EDGE_CASES.md §2 and AUDIT.md. Decoupling AI cost
// and latency from the load-bearing sync path is the whole point.
//
// Deterministic-first (the P1 fix): the AI's vocabulary
// (book_meeting, pricing, …) is DISJOINT from the vocabulary the Queue
// hides on (bounce, ooo_reply, calendar_accept, zoom_recap,
// meeting_confirmation, unsubscribe). Before this change only the
// one-shot Phase-1 backfill ever wrote a hide intent, so every bounce
// / OOO / calendar accept that arrived afterwards rendered in the
// Queue as a normal "reply needed" card. Running the same detectors
// the backfill used, in the same precedence order, ahead of the AI
// call makes the hide list reachable again — and saves an AI call on
// every routine auto-reply.
//
// Auth: requireScheduledCaller (X-Internal-Secret or service-role).
//
// Graceful degradation: rows past the 72-hour body-purge window have
// `snippet_text` NULL. The classifier still runs on subject + sender
// alone. Only rows with NO usable signal (no subject AND no sender
// AND no snippet) are written as `intent='unknown'` so they stop
// being re-polled.
//
// Per-row try/catch is hard: a single AI 5xx, parse error, or DB
// error must not throw out of the batch. Counts are logged at the
// end of every run.
//
// Retry backoff (Unit Q1c): every terminal failure branch now stamps
// `metadata_json` with `classify_attempts` / `classify_last_attempt_at`
// / `classify_last_error` / `classify_next_at` via
// `_shared/classifyRetry.ts`, and the candidate query filters on
// `classify_next_at` so a just-failed row cannot be re-selected on the
// next tick. Before this, a downstream outage (ai_task returning 402 on
// every call) froze the head of this deterministic order and starved
// every row behind it indefinitely. `intent` is still left NULL even at
// the retry ceiling — writing a terminal value would release the body
// for purging at 72h instead of the 7-day hard cap, and could hide a
// real customer question in the Queue.
//
// Run budget (Unit Q1c, second pass): the per-row loop stops starting
// new rows at CLASSIFY_RUN_BUDGET_MS (35 s), 20 s under the 55 s kill
// cron-dispatcher imposes. With the gateway restored, 25 rows of real
// AI calls took 47-55 s and every run was being killed, so the backlog
// stopped draining. Each row is committed by its own UPDATE as it
// completes, so stopping early banks the work; rows the budget never
// reached carry NO retry mark and are ordinary candidates next tick.
//
// Re-entrancy: the cron schedule is every minute. If a run overruns
// 60s, a second run can start while the first is in flight. Each
// UPDATE is guarded by `.is("intent", null)` so the loser of any
// race silently no-ops instead of clobbering a concurrent write.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "../_shared/logger.ts";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";
import {
  detectInboundIntent,
  readSubstantiveQuestionFlag,
  senderIsLead,
} from "../_shared/inboundIntentDetectors.ts";
import {
  type ClassifyFailureReason,
  CLASSIFY_AI_TIMEOUT_MS,
  CLASSIFY_OBSERVED_MS_PER_ROW,
  CLASSIFY_RUN_BUDGET_MS,
  BACKLOG_EXHAUSTED_AT,
  classifyBacklogState,
  CLASSIFY_NEXT_AT_KEY,
  classifyEligibilityFilter,
  isRunBudgetSpent,
  stripClassifyMarks,
  markClassifyFailure,
  recordFailedAttempt,
  selectClassifiable,
} from "../_shared/classifyRetry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-secret",
};

// Sized off MEASURED latency against a healthy gateway, not a guess.
//
// Production, 2026-09-13: with the gateway 402ing, 25 rows failed fast
// in 6–9 s. The minute credits were restored, the same 25 rows took
// 47–49 s of real AI calls and then tipped over cron-dispatcher's 55 s
// kill into back-to-back timeouts. BATCH_SIZE = 25 was tuned in the
// broken regime and does not survive the working one.
//
// 15 × ~1.9 s ≈ 29 s, inside CLASSIFY_RUN_BUDGET_MS (35 s) and barely
// half the 55 s kill, so a typical run finishes its whole batch. THE
// LATENCY ASSUMPTION THIS ENCODES: mean ai_task.intent_router
// round-trip ≈ 1.9 s — and that mean is DILUTED by deterministic rows
// that cost ~0, so a mostly-AI batch is nearer 2.2 s/row ≈ 33 s, about
// 93% of the budget. Still inside; the headroom is thinner than the
// arithmetic looks. Past ~2.3 s/row the budget truncates batches, which
// is safe (every row commits as it completes) but is the signal to
// lower this number.
//
// THIS NUMBER IS THE DRAIN RATE. The cron fires once a minute and works
// at most BATCH_SIZE rows, so throughput is BATCH_SIZE/minute FULL
// STOP — it is not wall-clock-bound. A batch of cheap deterministic
// rows finishes the RUN in 2 s instead of 29; it does not then go and
// work a 16th row. Fast rows shorten the run, never the drain. (The
// budget is a backstop, not a limiter — that is the whole design.) So
// 1,346 backlogged rows ÷ 15 = ~90 minutes regardless of email mix.
const BATCH_SIZE = 15;

// Rows are over-fetched so that a row parked by retry backoff can never
// consume one of the working slots. `classifyEligibilityFilter` is
// what actually keeps parked rows out, SERVER-SIDE; this headroom plus
// the in-memory `selectClassifiable` pass is a DETECTOR, not a spare
// tyre. ponytail: 2x is a guess, not a proof. It absorbs at most
// BATCH_SIZE leaked parked rows — TODAY 15, down from 25 when the batch
// shrank, so the margin is thinner than it was. With a backlog in the
// thousands, a server-side filter that stops matching parks all
// FETCH_LIMIT (30) fetched rows, selects none, and the queue
// re-freezes. Loudly (see
// `classify_inbound_server_backoff_filter_leaked`), but it freezes.
// Ceiling: a non-zero `parked` is not "handled", it is an incident —
// fix the server-side filter, do not raise this number.
const FETCH_LIMIT = BATCH_SIZE * 2;


// Classifier identifier written to `intent_version`. Bump the suffix
// when the prompt or model selection changes in a way that should
// trigger re-classification of older rows.
//
// v2 marker: prompt now also returns `ai_summary` (paraphrased
// 1–2 sentence durable summary). v1 rows do NOT have ai_summary in
// metadata_json — the read-side fallback in build-lead-context /
// ai_task handles the null gracefully. v1 rows are NOT auto-re-
// classified — they stay v1 (see KNOWN_ISSUES.md).
const INTENT_VERSION = "intent_router/v2";

// Code-state marker for inbound ai_summary writes. Stored alongside
// ai_summary in metadata_json so backfill jobs can identify rows that
// need re-summarizing whenever the summary-producing code path changes
// meaningfully. Kept in lock-step with the constant in
// backfill-inbound-summaries — bumping there without bumping here
// would force the backfill to re-process every freshly classified
// inbound on its first run.
//
// v4 — fix Outlook refetch in backfill (ConsistencyLevel header).
// v3 — added Outlook refetch + multi-line synth fallback in backfill.
// v2 — initial pilot (length-scaled bullet prompt).
const AI_SUMMARY_VERSION = "inbound_summary/v4";

// Allowed values returned by ai_task.intent_router (see
// supabase/functions/_shared/prompts.ts → PROMPTS.intent_router).
// We refuse anything outside this set and log it as a parse failure
// — better to leave the row NULL for a future run than to write an
// unknown enum-ish value that downstream queries can't reason about.
const ALLOWED_INTENTS: ReadonlySet<string> = new Set([
  "book_meeting",
  "pricing",
  "technical_sdk",
  "security_privacy",
  "legal_procurement",
  "partnership",
  "support",
  "not_sure",
]);

// Fallback intent for rows that have no usable content at all
// (no subject, no sender, no snippet — exceedingly rare). Writing a
// terminal value keeps the cron from spinning on the same row every
// minute. Mirrors the `unknown` value documented in
// 20260520120000_lead_timeline_items_intent.sql.
const NO_SIGNAL_INTENT = "unknown";

// Intents for which we DO NOT write `ai_summary` — no rep ever drafts
// a reply to these requiring body content (auto-replies, calendar
// acks, bounces, unsubscribes). Saves tokens AND avoids paraphrasing
// content that's already a structured artifact (calendar invite,
// OOO auto-text) into something less useful than the original.
//
// Intent is STILL written for these rows (queue filtering depends on
// it) — only ai_summary is skipped.
const SKIP_AI_SUMMARY_INTENTS: ReadonlySet<string> = new Set([
  NO_SIGNAL_INTENT,
  "calendar_accept",
  "ooo_reply",
  "bounce",
  "zoom_recap",
  "meeting_confirmation",
  "unsubscribe",
]);

interface TimelineRow {
  id: string;
  lead_id: string | null;
  subject: string | null;
  snippet_text: string | null;
  metadata_json: Record<string, unknown> | null;
}

interface LeadRow {
  id: string;
  name: string | null;
  company: string | null;
  email: string | null;
}

interface BatchCounts {
  fetched: number;
  classified: number;
  failed: number;
  /**
   * Fetched but NOT worked because retry backoff still parks them.
   * Should be 0 — the server-side filter is supposed to exclude these
   * before they reach us. Non-zero means that filter stopped matching.
   * (Replaces the old `skipped` counter, which was initialised and then
   * never incremented anywhere.)
   */
  parked: number;
  /**
   * Rows that hit the retry ceiling ON THIS RUN — counted when the
   * final failure mark is durably written, not from the pre-loop
   * candidate snapshot (a row is not exhausted yet when that is taken,
   * and is invisible to it forever after). Non-zero here is the signal
   * that a backlog is starting to give up.
   */
  exhausted: number;
  /**
   * Outstanding rows that gave up for good, probed on an otherwise-idle
   * run only (0 on a working run). Non-zero means the backlog is dead
   * and needs the MANUAL RECOVERY statement in
   * `_shared/classifyRetry.ts`. THIS is the number worth waking for.
   */
  backlog_exhausted: number;
  /**
   * Outstanding rows merely inside a retry window, same probe. These
   * resume by themselves — informational, never an incident, and
   * explicitly NOT a reason to run the recovery statement (doing so
   * would delete the backoff that is protecting a failing dependency).
   */
  backlog_backed_off: number;
  /**
   * Rows actually worked this run: `min(fetched - parked, BATCH_SIZE)`.
   *
   * `fetched` counts what the query RETURNED (up to FETCH_LIMIT = 50),
   * which is deliberately more than one batch — so `fetched` alone does
   * NOT add up against `classified + failed`. `worked` does. This log
   * line is the only observability this function has; it has to be
   * readable without the source open.
   */
  worked: number;
  /**
   * Selected but never started, because the run budget ran out first.
   * These rows carry NO retry mark — they were not attempted — and are
   * ordinary candidates again on the next tick.
   */
  unreached: number;
  /** True when the run stopped on the clock rather than finishing. */
  budget_stopped: boolean;
  /** Subset of classified — rows that got the NO_SIGNAL_INTENT fallback. */
  no_signal: number;
  /** Subset of classified — matched a deterministic detector, no AI call. */
  deterministic: number;
}

function buildLeadContext(lead: LeadRow | undefined): string {
  if (!lead) return "";
  const parts: string[] = [];
  if (lead.name) parts.push(`Name: ${lead.name}`);
  if (lead.company) parts.push(`Company: ${lead.company}`);
  return parts.join(", ");
}

function buildEmailText(row: TimelineRow): string {
  const fromEmail =
    typeof row.metadata_json?.from_email === "string"
      ? (row.metadata_json.from_email as string).trim()
      : "";
  const subject = (row.subject ?? "").trim();
  const snippet = (row.snippet_text ?? "").trim();

  const lines: string[] = [];
  if (fromEmail) lines.push(`From: ${fromEmail}`);
  if (subject) lines.push(`Subject: ${subject}`);
  if (snippet) {
    if (lines.length > 0) lines.push("");
    lines.push(snippet);
  }
  return lines.join("\n");
}

interface Classification {
  intent: string;
  /** May be null when the model omits the field (older clients) — caller
   *  treats that as "no summary this run" and skips the summary write. */
  ai_summary: string | null;
  /**
   * The rest of the intent_router JSON schema. The model has been
   * returning these on every call (and we have been paying for them)
   * since the prompt was written; until now they were parsed away and
   * dropped on the floor. They are persisted into `metadata_json` so
   * the Queue can hide non-reply-worthy noise and v2 can rank on
   * urgency / tone without a second AI round-trip.
   *
   * Every field is optional: a model that omits one must NOT fail the
   * row (the atomic-or-nothing rule covers `intent` + `ai_summary`
   * only — those two are what the 72h purge gate depends on).
   */
  signals: AiSignals;
}

/** Persisted verbatim under `metadata_json.ai_signals`. */
interface AiSignals {
  reply_worthy?: boolean;
  urgency?: string;
  tone?: string;
  questions_extracted?: string[];
  /**
   * ISO 639-1 code of the language the sender wrote in, requested by
   * `PROMPTS.intent_router`. Rows classified before that field was added
   * to the schema simply don't carry it — the parser omits what isn't
   * there rather than guessing.
   */
  language?: string;
}

const URGENCY_VALUES = new Set(["high", "medium", "low"]);
const TONE_VALUES = new Set(["positive", "neutral", "negative"]);

/**
 * Pull the four already-paid-for signals (+ language) out of the parsed
 * AI JSON. Defensive by design — anything malformed is simply omitted.
 */
function extractSignals(parsed: Record<string, unknown>): AiSignals {
  const out: AiSignals = {};

  if (typeof parsed.reply_worthy === "boolean") out.reply_worthy = parsed.reply_worthy;

  if (typeof parsed.urgency === "string") {
    const u = parsed.urgency.trim().toLowerCase();
    if (URGENCY_VALUES.has(u)) out.urgency = u;
  }

  if (typeof parsed.tone === "string") {
    const t = parsed.tone.trim().toLowerCase();
    if (TONE_VALUES.has(t)) out.tone = t;
  }

  if (Array.isArray(parsed.questions_extracted)) {
    const qs = parsed.questions_extracted
      .filter((q): q is string => typeof q === "string")
      .map((q) => q.trim())
      .filter((q) => q.length > 0)
      // Bounded: questions are rendered on a card, and metadata_json is
      // preserved indefinitely (it survives the 72h body purge).
      .slice(0, 10)
      .map((q) => q.slice(0, 300));
    if (qs.length > 0) out.questions_extracted = qs;
  }

  if (typeof parsed.language === "string") {
    const l = parsed.language.trim().toLowerCase();
    if (l.length > 0 && l.length <= 32) out.language = l;
  }

  return out;
}

/**
 * `from_email` off the timeline row's metadata, if present. Left raw —
 * `senderIsLead` / `bareEmail` normalize, and the detector chain wants
 * the original for bounce-sender matching.
 */
function fromEmailOf(row: TimelineRow): string {
  return typeof row.metadata_json?.from_email === "string"
    ? (row.metadata_json.from_email as string).trim()
    : "";
}

/**
 * Robustly extract a JSON object from an AI response that may be:
 *  - wrapped in ```json … ``` markdown fences
 *  - prefixed/suffixed with prose
 *  - truncated mid-object (we attempt to recover the longest balanced prefix)
 */
function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  // Strip markdown code fences (```json … ``` or plain ```).
  let s = raw
    .replace(/```json\s*/gi, "")
    .replace(/```/g, "")
    .trim();

  // Direct parse first.
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fall through */ }

  // Locate the first object.
  const start = s.indexOf("{");
  if (start === -1) return null;
  s = s.slice(start);

  // Try the greedy {…} slice first.
  const greedyEnd = s.lastIndexOf("}");
  if (greedyEnd > 0) {
    try {
      const v = JSON.parse(s.slice(0, greedyEnd + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* fall through */ }
  }

  // Walk forward and find every balanced closing brace; try parsing each candidate
  // from longest to shortest. Handles truncation by recovering the longest valid prefix.
  const candidates: number[] = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) candidates.push(i);
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(s.slice(0, candidates[i] + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* try next */ }
  }
  return null;
}

function extractClassification(content: string): Classification | null {
  const parsed = tryParseJsonObject(content) as {
    intent_primary?: unknown;
    ai_summary?: unknown;
  } | null;
  if (!parsed) return null;
  if (typeof parsed.intent_primary !== "string") return null;
  const intent = parsed.intent_primary.trim();
  if (!ALLOWED_INTENTS.has(intent)) return null;

  let summary: string | null = null;
  if (typeof parsed.ai_summary === "string") {
    const trimmed = parsed.ai_summary.trim();
    if (trimmed.length > 0) summary = trimmed;
  }

  return {
    intent,
    ai_summary: summary,
    signals: extractSignals(parsed as Record<string, unknown>),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = requireScheduledCaller(req, corsHeaders);
  if (auth instanceof Response) return auth;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const counts: BatchCounts = {
    fetched: 0,
    classified: 0,
    failed: 0,
    parked: 0,
    exhausted: 0,
    worked: 0,
    unreached: 0,
    budget_stopped: false,
    backlog_exhausted: 0,
    backlog_backed_off: 0,
    no_signal: 0,
    deterministic: 0,
  };
  const startedAt = Date.now();

  // One tally per reason code instead of 25 individual warn lines —
  // a run summary is what an operator can actually act on, and
  // cron-dispatcher does not persist this function's response body
  // (pg_net times out at 5s first), so the log IS the only record.
  const failureReasons: Record<string, number> = {};

  /**
   * The ONLY way this function is allowed to give up on a row.
   *
   * Writes the attempt record back to `metadata_json` so the row is
   * (a) distinguishable from one never touched and (b) excluded from
   * the next candidate query until its backoff expires. Never writes
   * `intent` — see `_shared/classifyRetry.ts` for why a terminal intent
   * would purge the body early and hide a real customer question.
   */
  const failRow = async (
    row: TimelineRow,
    reason: ClassifyFailureReason,
  ): Promise<void> => {
    // recordFailedAttempt owns BOTH the bookkeeping and the write, and
    // never throws — so a transient failure of this UPDATE cannot
    // re-enter through the per-row catch and book the same row twice.
    // (Codex P2: the failure counter moves before the write, so a throw
    // here used to double-count and break the
    // `worked === classified + failed` reconciliation on the one path
    // where the numbers matter most.)
    //
    // `updated_at` is deliberately NOT touched: a failed read of an
    // email is not activity on the lead.
    const mark = markClassifyFailure(
      row.metadata_json,
      reason,
      new Date().toISOString(),
    );
    const markError = await recordFailedAttempt(
      counts,
      failureReasons,
      reason,
      mark,
      () =>
        admin
          .from("lead_timeline_items")
          .update({ metadata_json: mark })
          .eq("id", row.id)
          .is("intent", null),
    );
    if (markError) {
      // The row is counted, but unmarked — so it comes back next minute
      // with no backoff. Loud, because this is the old freeze condition.
      logger.error("classify_inbound_attempt_mark_failed", {
        row_id: row.id,
        reason,
        error: markError,
      });
    }
  };

  try {
    // Priority sort: `expires_at ASC NULLS LAST, occurred_at ASC` —
    // near-expiry rows get classified first. Prevents a backlog from
    // accumulating at the back of the queue during a large offline-sync
    // (e.g. a workspace just hooked up Gmail and 2k inbounds arrive in
    // a single batch — without this, the oldest occurred_at ties up the
    // first N runs while the freshest-but-about-to-purge rows wait).
    //
    // Retry backoff (the Q1c fix): `.or(classifyEligibilityFilter(...))`
    // drops rows whose next attempt is still in the future SERVER-SIDE,
    // so a row parked after a failure cannot occupy a slot. Without it,
    // a downstream outage freezes the head of this deterministic order
    // and starves every row behind it — which is exactly what happened
    // when ai_task started returning 402 on every call.
    const nowIso = new Date().toISOString();
    const candidates = (withBackoffFilter: boolean) => {
      const q = admin
        .from("lead_timeline_items")
        .select("id, lead_id, subject, snippet_text, metadata_json")
        .eq("event_type", "email_inbound")
        .is("intent", null);
      if (withBackoffFilter) q.or(classifyEligibilityFilter(nowIso));
      return q
        .order("expires_at", { ascending: true, nullsFirst: false })
        .order("occurred_at", { ascending: true })
        .limit(FETCH_LIMIT);
    };

    let { data: rows, error: fetchErr } = await candidates(true);

    if (fetchErr) {
      // The JSON-path predicate is the only new thing in that query, so
      // a fetch error here most likely means this PostgREST build won't
      // filter on `metadata_json->>key`. Degrade to the in-memory pass
      // (which is why FETCH_LIMIT over-fetches) rather than doing no
      // work at all — but say so loudly, because parked rows are now
      // eating slots again.
      logger.error("classify_inbound_backoff_filter_unsupported", {
        error: fetchErr.message,
      });
      ({ data: rows, error: fetchErr } = await candidates(false));
    }

    if (fetchErr) {
      logger.error("classify_inbound_fetch_failed", { error: fetchErr.message });
      return new Response(
        JSON.stringify({ ok: false, error: fetchErr.message, ...counts }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const fetched = (rows ?? []) as TimelineRow[];
    const { selected: batch, parked, exhausted: parkedExhausted } =
      selectClassifiable(fetched, nowIso, BATCH_SIZE);
    counts.fetched = fetched.length;
    counts.parked = parked;
    // counts.exhausted is NOT set from this snapshot. A row becomes
    // exhausted during the loop, after the snapshot is taken, and from
    // the next tick the server-side filter hides it from the candidate
    // set — so a snapshot-derived count is structurally always 0.
    // recordFailedAttempt increments it when the final mark lands.
    // Counted DOWN as rows are worked, so it stays truthful even if the
    // outer catch fires mid-batch (where a post-loop tally would read 0).
    counts.unreached = batch.length;
    // counts.worked is set after the loop — the run budget can stop it
    // short, and `classified + failed` must always reconcile against it.
    if (parked > 0) {
      // The server-side predicate should have made this impossible.
      logger.warn("classify_inbound_server_backoff_filter_leaked", {
        parked,
        parked_exhausted: parkedExhausted,
        fetched: fetched.length,
      });
    }

    if (batch.length === 0) {
      // WHY an idle run is idle. Three states, three responses: nothing
      // to do / wait for the backoff / act. Splitting the middle case
      // out is the point — the first quiet minute of any ordinary blip
      // has every row inside its five-minute backoff, and telling an
      // operator to run the recovery statement then would DELETE that
      // backoff and hurl the whole batch back at a failing dependency.
      //
      // COUNTS, not rows. PostgREST caps a response (hosted default
      // 1,000 rows; no max_rows override in this project), so scanning
      // rows would have answered from an arbitrary subset at exactly the
      // scale this alarm exists for — and could have missed the
      // exhausted ones entirely. A count is exact whatever the cap.
      //
      // Idle runs ONLY — never on a run that has work. Three small
      // queries, each returning a number or a single row.
      const outstanding = admin
        .from("lead_timeline_items")
        .select("id", { count: "exact", head: true })
        .eq("event_type", "email_inbound")
        .is("intent", null);

      // (1) The number that fires the alarm. No ordering, no row cap in
      // play, and independent of the other two — if they fail, this one
      // still decides correctly.
      const { count: exhaustedCount, error: exhaustedErr } = await outstanding
        .eq(`metadata_json->>${CLASSIFY_NEXT_AT_KEY}`, BACKLOG_EXHAUSTED_AT);

      // (2) Backed off = parked but not given up.
      const { count: backedOffCount, error: backedOffErr } = await admin
        .from("lead_timeline_items")
        .select("id", { count: "exact", head: true })
        .eq("event_type", "email_inbound")
        .is("intent", null)
        .gt(`metadata_json->>${CLASSIFY_NEXT_AT_KEY}`, nowIso)
        .neq(`metadata_json->>${CLASSIFY_NEXT_AT_KEY}`, BACKLOG_EXHAUSTED_AT);

      // (3) When work resumes. Purely informational, and the ONLY query
      // here that needs an ordering — so if ordering on a JSON path is
      // unsupported, the alarm above is unaffected and only this goes
      // null.
      const { data: soonest, error: soonestErr } = await admin
        .from("lead_timeline_items")
        .select(`next_at:metadata_json->>${CLASSIFY_NEXT_AT_KEY}`)
        .eq("event_type", "email_inbound")
        .is("intent", null)
        .gt(`metadata_json->>${CLASSIFY_NEXT_AT_KEY}`, nowIso)
        .neq(`metadata_json->>${CLASSIFY_NEXT_AT_KEY}`, BACKLOG_EXHAUSTED_AT)
        .order(`metadata_json->>${CLASSIFY_NEXT_AT_KEY}`, { ascending: true })
        .limit(1);

      const probeErr = exhaustedErr ?? backedOffErr ?? soonestErr;
      if (probeErr) {
        // A failed probe must not manufacture an alarm — but it must
        // not hide one either, so say which part failed.
        logger.warn("classify_inbound_backlog_probe_failed", {
          error: probeErr.message,
          exhausted_ok: !exhaustedErr,
          backed_off_ok: !backedOffErr,
          soonest_ok: !soonestErr,
        });
      }

      const backlog = {
        exhausted: exhaustedCount ?? 0,
        backed_off: backedOffCount ?? 0,
        next_retry_at:
          ((soonest ?? []) as { next_at: string | null }[])[0]?.next_at ?? null,
      };
      counts.backlog_exhausted = backlog.exhausted;
      counts.backlog_backed_off = backlog.backed_off;

      const state = classifyBacklogState(batch.length, backlog);
      if (state === "exhausted") {
        // The ONLY line that means "act": rows have burned the whole
        // retry ladder and will never resume without the MANUAL
        // RECOVERY statement in _shared/classifyRetry.ts.
        logger.warn("classify_inbound_backlog_exhausted", {
          ...backlog,
          duration_ms: Date.now() - startedAt,
        });
      } else if (state === "backed_off") {
        // Informational on purpose. This is the system working.
        logger.info("classify_inbound_backlog_backed_off", {
          ...backlog,
          duration_ms: Date.now() - startedAt,
        });
      } else {
        logger.info("classify_inbound_empty_batch", {
          duration_ms: Date.now() - startedAt,
        });
      }
      return new Response(
        JSON.stringify({
          ok: true,
          ...counts,
          backlog_state: state,
          backlog_next_retry_at: backlog.next_retry_at,
          duration_ms: Date.now() - startedAt,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Single bulk lead-context fetch keeps per-row work tight.
    const leadIds = Array.from(
      new Set(batch.map((r) => r.lead_id).filter((id): id is string => !!id)),
    );
    const leadById = new Map<string, LeadRow>();
    if (leadIds.length > 0) {
      const { data: leads, error: leadErr } = await admin
        .from("leads")
        .select("id, name, company, email")
        .in("id", leadIds);
      if (leadErr) {
        // Non-fatal — we can still classify on email subject + sender alone.
        logger.warn("classify_inbound_lead_fetch_failed", { error: leadErr.message });
      }
      for (const l of ((leads ?? []) as LeadRow[])) leadById.set(l.id, l);
    }

    for (const row of batch) {
      // Wall-clock budget, checked BEFORE any work on this row.
      //
      // A partial batch that banks its work beats a full batch that
      // gets killed at 55 s. Breaking here (rather than marking) is
      // load-bearing: a row we never reached was never ATTEMPTED, so it
      // must carry no retry mark and must be a first-class candidate on
      // the next tick. `failRow` is deliberately not called on this
      // path. Pinned by src/test/classifyInboundResilience.test.ts.
      if (isRunBudgetSpent(Date.now() - startedAt)) {
        counts.budget_stopped = true;
        break;
      }
      // Incremented here, not tallied after the loop, so the count is
      // still truthful if the outer catch fires mid-batch.
      counts.worked++;
      counts.unreached--;
      try {
        const emailText = buildEmailText(row);

        if (!emailText) {
          // No subject, no sender, no body. Write `unknown` so the
          // cron stops re-polling this row.
          const { error: updErr } = await admin
            .from("lead_timeline_items")
            .update({
              intent: NO_SIGNAL_INTENT,
              intent_version: INTENT_VERSION,
              metadata_json: stripClassifyMarks({ ...(row.metadata_json ?? {}) }),
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id)
            .is("intent", null);
          if (updErr) {
            logger.error("classify_inbound_no_signal_update_failed", {
              row_id: row.id,
              error: updErr.message,
            });
            await failRow(row, "db_update_failed");
          } else {
            counts.classified++;
            counts.no_signal++;
          }
          continue;
        }

        const lead = row.lead_id ? leadById.get(row.lead_id) : undefined;
        const fromEmail = fromEmailOf(row);
        const sender_is_lead = senderIsLead(fromEmail, lead?.email);

        // ── Deterministic detectors FIRST (the P1 fix) ────────────────
        // These emit exactly the six intents the Queue hides on. All six
        // are in SKIP_AI_SUMMARY_INTENTS — no rep ever drafts a reply to
        // a bounce or an OOO — so short-circuiting the AI call here does
        // NOT starve the purge gate of an `ai_summary` it would otherwise
        // have got. (`defer_request` is deliberately excluded from the
        // detector chain for exactly that reason: it IS a human email and
        // must keep flowing to the AI so it gets a durable summary.)
        //
        // No email headers are available on a timeline row, so the OOO
        // header check can't run here — subject + body patterns only,
        // same limitation the Phase-1 backfill documented. The live sync
        // paths still get the header signal.
        // `snippet_text` is truncated to 500 chars by timelineProjector, so
        // a question sitting past that cut is invisible here. The sync path
        // decided the substantive-question verdict against the FULL body and
        // persisted it; honour that rather than re-deriving from the snippet
        // and silently overturning it (Codex P1, PR #143).
        const deterministic = detectInboundIntent({
          fromEmail,
          subject: row.subject ?? "",
          body: row.snippet_text ?? "",
          substantiveQuestion: readSubstantiveQuestionFlag(row.metadata_json),
        });

        if (deterministic.intent) {
          const { error: detErr } = await admin
            .from("lead_timeline_items")
            .update({
              intent: deterministic.intent,
              intent_version: INTENT_VERSION,
              metadata_json: stripClassifyMarks({
                ...(row.metadata_json ?? {}),
                intent_source: "deterministic",
                sender_is_lead,
              }),
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id)
            .is("intent", null);

          if (detErr) {
            logger.error("classify_inbound_deterministic_update_failed", {
              row_id: row.id,
              intent: deterministic.intent,
              error: detErr.message,
            });
            await failRow(row, "db_update_failed");
          } else {
            counts.classified++;
            counts.deterministic++;
          }
          continue;
        }

        const leadContext = buildLeadContext(lead);

        // AbortSignal is what makes CLASSIFY_RUN_BUDGET_MS mean
        // anything: the budget gates STARTING a row, it cannot bound a
        // call already in flight, and Deno's fetch has no default
        // timeout. Without this, one hung gateway call blows straight
        // through cron-dispatcher's 55 s kill. An abort throws and is
        // caught below as an ordinary AI failure, so the row marks and
        // backs off like any other.
        const aiRes = await fetch(`${supabaseUrl}/functions/v1/ai_task`, {
          method: "POST",
          signal: AbortSignal.timeout(CLASSIFY_AI_TIMEOUT_MS),
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            task: "intent_router",
            payload: {
              lead_context: leadContext,
              email_text: emailText,
            },
          }),
        });

        if (!aiRes.ok) {
          // No per-row log line: with the gateway down this fires for
          // every row in the batch. The reason code (incl. the HTTP
          // status) lands on the row AND in the run summary.
          await failRow(row, `ai_http_${aiRes.status}`);
          continue;
        }

        const aiData = (await aiRes.json()) as { ok?: boolean; content?: string };
        if (!aiData?.ok || typeof aiData.content !== "string" || !aiData.content) {
          await failRow(row, "ai_no_content");
          continue;
        }

        const classification = extractClassification(aiData.content);
        if (!classification) {
          // Parse failure, out-of-vocab intent, or missing intent.
          // Leave intent NULL so a future run (or a future classifier
          // version) can retry. Atomic-or-nothing: we never write one
          // field without the other being parseable.
          //
          // NOTE: intent_router does not currently return a confidence
          // score per its prompt schema, so the low-confidence-→-NULL
          // branch described in earlier briefs reduces to "parse failed
          // → NULL" here. If/when the prompt gains `confidence`, add
          // a threshold check and route low-confidence results through
          // the same NULL path.
          logger.warn("classify_inbound_ai_parse_failed", {
            row_id: row.id,
            content_preview: aiData.content.slice(0, 120),
          });
          await failRow(row, "ai_parse_failed");
          continue;
        }

        const { intent: intentPrimary, ai_summary, signals } = classification;

        // Atomic-or-nothing enforcement: if the intent is NOT in the
        // skip-list, ai_summary is REQUIRED. A row that parses to a
        // substantive intent but no summary must be treated as a parse
        // failure — otherwise we'd write `intent` and the `intent IS
        // NULL` candidate query would never pick it back up, leaving
        // the row permanently without a durable summary and degrading
        // reply context after the 72h purge.
        //
        // (Codex P1 on PR #49 — without this, a model that drops the
        // ai_summary field for any reason silently produces classified-
        // but-summary-less rows.)
        const isSkipListIntent = SKIP_AI_SUMMARY_INTENTS.has(intentPrimary);
        if (!isSkipListIntent && ai_summary === null) {
          logger.warn("classify_inbound_ai_summary_missing_for_substantive_intent", {
            row_id: row.id,
            intent: intentPrimary,
            content_preview: aiData.content.slice(0, 120),
          });
          await failRow(row, "ai_summary_missing");
          continue;
        }

        // Build the metadata_json merge payload. Only merge ai_summary
        // when it's a non-empty string AND the intent is not in the
        // skip list (auto-replies / calendar acks / bounces never need
        // a body summary). Preserves existing fields (from_email,
        // to_emails, ...) via row-level spread.
        //
        // The AI signals (reply_worthy / urgency / tone /
        // questions_extracted / language) and the sender-identity flag
        // ride along on EVERY AI-classified row, summary or not — we
        // already paid for them in the same call.
        const shouldWriteSummary = ai_summary !== null && !isSkipListIntent;

        // stripClassifyMarks: a row that eventually classifies must not
        // keep the retry bookkeeping from the outage it lived through.
        const nextMetadata: Record<string, unknown> = stripClassifyMarks({
          ...(row.metadata_json ?? {}),
          intent_source: "ai",
          sender_is_lead,
          ai_signals: signals,
        });
        if (shouldWriteSummary) {
          nextMetadata.ai_summary = ai_summary;
          nextMetadata.ai_summary_version = AI_SUMMARY_VERSION;
        }

        // Single UPDATE — intent + (optional) ai_summary land together
        // or not at all. The `.is("intent", null)` guard makes
        // concurrent runs idempotent: the loser silently no-ops.
        const updatePayload: Record<string, unknown> = {
          intent: intentPrimary,
          intent_version: INTENT_VERSION,
          metadata_json: nextMetadata,
          updated_at: new Date().toISOString(),
        };

        const { error: updErr } = await admin
          .from("lead_timeline_items")
          .update(updatePayload)
          .eq("id", row.id)
          .is("intent", null);

        if (updErr) {
          logger.error("classify_inbound_update_failed", {
            row_id: row.id,
            intent: intentPrimary,
            error: updErr.message,
          });
          await failRow(row, "db_update_failed");
          continue;
        }

        counts.classified++;
      } catch (err) {
        // Hard guarantee: this catch is the last line of defence. Any
        // thrown error from ai_task fetch, JSON parsing, or the
        // supabase client lands here and the batch keeps going.
        const msg = err instanceof Error ? err.message : String(err);
        // AbortSignal.timeout rejects with a TimeoutError DOMException;
        // an explicit abort would be AbortError. Both mean "the gateway
        // did not answer in time", which is a distinct, actionable
        // reason — not the generic one.
        const name = (err as { name?: string } | null)?.name;
        const timedOut = name === "TimeoutError" || name === "AbortError";
        logger.error("classify_inbound_row_unexpected_error", {
          row_id: row.id,
          error: msg,
          timed_out: timedOut,
        });
        // Best-effort mark; if this throws too the outer loop continues.
        // No .catch needed: failRow cannot reject (recordFailedAttempt
        // fences its own write), which is what keeps this row counted
        // exactly once.
        await failRow(row, timedOut ? "ai_timeout" : "unexpected_error");
      }
    }

    logger.info("classify_inbound_batch_done", {
      duration_ms: Date.now() - startedAt,
      ...counts,
      failure_reasons: failureReasons,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        ...counts,
        failure_reasons: failureReasons,
        duration_ms: Date.now() - startedAt,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("classify_inbound_fatal", { error: msg, ...counts });
    return new Response(
      JSON.stringify({ ok: false, error: msg, ...counts }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
