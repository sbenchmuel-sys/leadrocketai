// ============================================================
// classifyRetry — attempt bookkeeping + backoff for classify-inbound.
//
// WHY THIS EXISTS
// ---------------
// `classify-inbound` selects rows with `intent IS NULL` in a fully
// deterministic order and classifies at most BATCH_SIZE of them per
// minute. Four of its five terminal branches used to fail WITHOUT
// writing anything back to the row. When the AI gateway is down (in
// production: HTTP 402 "Not enough credits" on every call) the same
// head-of-queue rows were re-selected, re-failed and abandoned every
// single minute — forever — while everything behind them starved.
//
// The fix has two halves, both of which live here so a vitest spec can
// exercise them (the edge function itself only runs under Deno):
//
//   1. Every terminal failure stamps the row with a compact record of
//      the attempt (`markClassifyFailure`), so "attempted and failed"
//      is distinguishable from "never touched".
//   2. The candidate query refuses to re-select a row whose next
//      attempt is still in the future (`classifyEligibilityFilter`
//      server-side, `selectClassifiable` as the in-memory belt).
//
// The marks live on `metadata_json` as FLAT top-level keys, on purpose:
// PostgREST can filter `metadata_json->>classify_next_at` in the same
// query that selects the batch, so parked rows never consume a slot.
// A nested object would need `->` chaining inside an `or()` string,
// which is far more fragile.
//
// TIMESTAMP COMPARISON: `metadata_json->>classify_next_at` is TEXT to
// PostgREST, so the server-side comparison is lexicographic. That is
// exactly equivalent to chronological order for `Date#toISOString()`
// output (fixed-width `YYYY-MM-DDTHH:mm:ss.sssZ`, always UTC). Never
// write any other timestamp format into that key.
//
// INTENT STAYS NULL. Even at the retry ceiling we do NOT write a
// terminal `intent`, because `intent` is load-bearing in two places:
//   • Queue hide logic treats NULL as "not hidden" — a customer's real
//     question must never be hidden just because we failed to read it.
//   • The retention purge gate releases an inbound row's body for
//     purging once `intent IS NOT NULL` — writing a give-up value
//     would purge the body at 72h instead of the 7-day hard cap.
// Exhaustion is therefore recorded in metadata only.
// ============================================================

/** `metadata_json` keys this module owns. Nothing else may write them. */
export const CLASSIFY_ATTEMPTS_KEY = "classify_attempts";
export const CLASSIFY_LAST_ATTEMPT_KEY = "classify_last_attempt_at";
export const CLASSIFY_LAST_ERROR_KEY = "classify_last_error";
export const CLASSIFY_NEXT_AT_KEY = "classify_next_at";
export const CLASSIFY_EXHAUSTED_KEY = "classify_exhausted_at";

const ALL_KEYS = [
  CLASSIFY_ATTEMPTS_KEY,
  CLASSIFY_LAST_ATTEMPT_KEY,
  CLASSIFY_LAST_ERROR_KEY,
  CLASSIFY_NEXT_AT_KEY,
  CLASSIFY_EXHAUSTED_KEY,
] as const;

/**
 * The wait BETWEEN attempts, in minutes. Index 0 is the wait after the
 * 1st failure. N attempts have N-1 gaps between them, so this table has
 * one entry FEWER than `MAX_CLASSIFY_ATTEMPTS` — there is no wait after
 * the last failure, because there is no attempt after it to wait for
 * (`nextAttemptIso` short-circuits to the never-sentinel instead).
 *
 * Keep it that way. An entry per attempt would leave the final one
 * permanently unread — dead code that silently overstates the ceiling
 * to anyone who adds the column up. That is a real hazard, not a typo:
 * the credit-restore deadline is sized off this number.
 *
 * Total wall-clock before exhaustion: 5m + 15m + 45m + 2h + 6h + 12h +
 * 24h = 2,705 minutes ≈ 45 hours ≈ 1.9 days of continuous gateway
 * failure. `CLASSIFY_TOTAL_BACKOFF_MINUTES` below is that number,
 * derived rather than restated, and pinned by a test that walks the
 * real clock rather than re-summing the table.
 *
 * ponytail: a fixed table beats a formula here — the numbers are the
 * product decision ("how long do we keep paying for a doomed retry"),
 * and reading them off one line is worth more than deriving them.
 * Ceiling: an outage longer than ~45 hours parks the backlog
 * permanently and it needs an operator to clear `classify_exhausted_at`.
 */
export const CLASSIFY_BACKOFF_MINUTES: readonly number[] = [
  5, 15, 45, 120, 360, 720, 1440,
];

/** Attempts before a row is given up on: one more than the gaps above. */
export const MAX_CLASSIFY_ATTEMPTS = CLASSIFY_BACKOFF_MINUTES.length + 1;

/**
 * Wall-clock minutes from a row's first failure to its exhaustion.
 * Derived, never hand-written — the deploy plan is sized off this
 * number, so a comment claiming one thing while the table says another
 * is a real operational hazard, not a typo.
 */
export const CLASSIFY_TOTAL_BACKOFF_MINUTES = CLASSIFY_BACKOFF_MINUTES
  .reduce((a, b) => a + b, 0);

/**
 * Sentinel written to `classify_next_at` once a row is exhausted. Being
 * a real (far-future) ISO timestamp means the ONE server-side filter
 * excludes both parked and exhausted rows — no second predicate.
 */
export const CLASSIFY_NEVER_ISO = "9999-12-31T00:00:00.000Z";

// ── Run budget ─────────────────────────────────────────────────────
//
// `cron-dispatcher` kills a target at 55 s. While the AI gateway was
// returning 402 on every call, 25 rows failed fast in 6–9 s, which is
// the regime BATCH_SIZE = 25 was tuned in. The moment credits were
// restored, 25 REAL AI calls took 47–55 s and the cron tipped straight
// into back-to-back timeouts: 17:56–17:59 ok at ~48 s, 18:00 onward
// killed at 55 s.
//
// Batch size alone only moves that cliff — it does not remove it, since
// AI latency is variable and a single slow call can blow any fixed
// batch. So the real limiter is wall-clock: stop starting new rows once
// the budget is spent, bank what is done, let the next tick continue.

/** Hard kill imposed by cron-dispatcher on any target. */
export const CLASSIFY_DISPATCHER_TIMEOUT_MS = 55_000;

/**
 * Stop starting new rows after this much elapsed time.
 *
 * 20 s of headroom under the dispatcher's kill, so a call already in
 * flight when the budget expires can still finish and commit. That is
 * only a real guarantee because `CLASSIFY_AI_TIMEOUT_MS` bounds the
 * call — the budget gates STARTING a row, it cannot bound one already
 * running, and Deno's fetch has no default timeout.
 */
export const CLASSIFY_RUN_BUDGET_MS = 35_000;

/**
 * Hard ceiling on a single `ai_task` round-trip, via AbortSignal.
 *
 * The invariant this exists to satisfy (pinned by a test):
 *   CLASSIFY_RUN_BUDGET_MS + CLASSIFY_AI_TIMEOUT_MS
 *     < CLASSIFY_DISPATCHER_TIMEOUT_MS
 * i.e. 35 s + 15 s = 50 s < 55 s, leaving 5 s for the failure write and
 * the response. Without it, one hung gateway call blows through the
 * 55 s kill no matter what the run budget says. An abort is treated as
 * an ordinary AI failure, so the row marks and backs off like any other
 * — it does NOT burn the run.
 */
export const CLASSIFY_AI_TIMEOUT_MS = 15_000;

/**
 * Observed mean seconds-per-row against a HEALTHY gateway (47–49 s for
 * 25 rows, production, 2026-09-13 17:56–17:59). BATCH_SIZE is sized off
 * this. If mean latency rises above ~2.3 s/row the budget starts
 * truncating batches — harmless (work is banked per row), but it is the
 * signal to lower BATCH_SIZE rather than let every run stop short.
 *
 * CAVEAT — this is a DILUTED mean. Some of those 25 rows were almost
 * certainly deterministic and cost ~0, so the true cost of an AI row is
 * nearer 2.2 s and a mostly-AI batch of 15 lands around 33 s: ~93% of
 * the run budget, not the ~81% a naive 1.9 × 15 suggests. Still inside,
 * and it degrades gracefully (the budget truncates, work is banked) —
 * but the headroom is thinner than the arithmetic looks. Deliberately
 * NOT re-tuned off a four-run sample; re-measure after a day of real
 * traffic and adjust BATCH_SIZE then.
 */
export const CLASSIFY_OBSERVED_MS_PER_ROW = 1_900;

/**
 * The one decision the per-row loop makes before starting a row.
 * `>=` not `>`: at exactly the budget we stop, we do not start one more.
 */
export function isRunBudgetSpent(elapsedMs: number): boolean {
  return elapsedMs >= CLASSIFY_RUN_BUDGET_MS;
}

/** Short, stable reason codes stored in `classify_last_error`. */
export type ClassifyFailureReason =
  | `ai_http_${number}`
  | "ai_timeout"
  | "unexpected_error"
  | "ai_no_content"
  | "ai_parse_failed"
  | "ai_summary_missing"
  | "db_update_failed";

type Meta = Record<string, unknown> | null | undefined;

function readNumber(meta: Meta, key: string): number {
  const v = meta?.[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function readString(meta: Meta, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** How many times this row has already been attempted and failed. */
export function readClassifyAttempts(meta: Meta): number {
  return readNumber(meta, CLASSIFY_ATTEMPTS_KEY);
}

/** True once the row has burned through the whole backoff table. */
export function isClassifyExhausted(meta: Meta): boolean {
  return readString(meta, CLASSIFY_EXHAUSTED_KEY) !== null ||
    readClassifyAttempts(meta) >= MAX_CLASSIFY_ATTEMPTS;
}

/**
 * Is this row allowed to consume a classification slot right now?
 * A row with no marks at all (the overwhelming majority) is eligible.
 */
export function isClassifyEligible(meta: Meta, nowIso: string): boolean {
  const next = readString(meta, CLASSIFY_NEXT_AT_KEY);
  if (next === null) return true;
  return next <= nowIso; // lexicographic == chronological for toISOString()
}

/** The JSON path PostgREST filters on. */
const CLASSIFY_NEXT_AT_KEY_PATH = `metadata_json->>${CLASSIFY_NEXT_AT_KEY}`;

/**
 * The PostgREST `or()` predicate that keeps parked and exhausted rows
 * out of the candidate query SERVER-SIDE, so they never occupy one of
 * the batch's slots.
 *
 * `metadata_json->>key` is NULL both when `metadata_json` is NULL and
 * when the key is absent, so `is.null` covers every never-attempted row.
 */
export function classifyEligibilityFilter(nowIso: string): string {
  return `${CLASSIFY_NEXT_AT_KEY_PATH}.is.null,${CLASSIFY_NEXT_AT_KEY_PATH}.lte.${nowIso}`;
}

/** ISO timestamp of the next allowed attempt after `attempts` failures. */
export function nextAttemptIso(attempts: number, nowIso: string): string {
  if (attempts >= MAX_CLASSIFY_ATTEMPTS) return CLASSIFY_NEVER_ISO;
  const minutes = CLASSIFY_BACKOFF_MINUTES[Math.max(0, attempts - 1)];
  return new Date(Date.parse(nowIso) + minutes * 60_000).toISOString();
}

/**
 * Merge a failed-attempt record into the row's existing metadata.
 * Returns a NEW object — callers pass it straight into the UPDATE, so
 * every other metadata field (from_email, to_emails, …) is preserved.
 *
 * Deliberately does NOT write `sender_is_lead`: the Queue hides a row
 * whose `sender_is_lead` is `false`, and a failed classification must
 * never change what the rep sees.
 */
export function markClassifyFailure(
  meta: Meta,
  reason: ClassifyFailureReason,
  nowIso: string,
): Record<string, unknown> {
  const attempts = readClassifyAttempts(meta) + 1;
  const out: Record<string, unknown> = {
    ...(meta ?? {}),
    [CLASSIFY_ATTEMPTS_KEY]: attempts,
    [CLASSIFY_LAST_ATTEMPT_KEY]: nowIso,
    [CLASSIFY_LAST_ERROR_KEY]: reason,
    [CLASSIFY_NEXT_AT_KEY]: nextAttemptIso(attempts, nowIso),
  };
  if (attempts >= MAX_CLASSIFY_ATTEMPTS) out[CLASSIFY_EXHAUSTED_KEY] = nowIso;
  return out;
}

/**
 * Book ONE failed attempt and write its mark, without ever throwing.
 *
 * Non-throwing is the whole point, not a nicety. The caller runs inside
 * a per-row try/catch whose catch ALSO books a failure — so if this
 * function could reject after incrementing, the catch would book the
 * same row a second time: `failed` counted twice, the reason tallied
 * twice, and the `worked === classified + failed` reconciliation broken
 * on exactly the path (a flaky DB write) where an operator is most
 * likely to be reading the numbers. Incrementing FIRST is what makes
 * that possible, so the write is fenced instead of the counter moved.
 *
 * `write` is passed as a thunk so this module stays runtime-pure — it
 * never sees a Supabase client, only a promise of `{ error }`.
 *
 * Returns null when the mark landed, otherwise the error message. A row
 * whose mark could NOT be written is still counted exactly once (it was
 * worked, it did fail) but carries no mark, so it comes back as an
 * ordinary unmarked candidate on the very next tick — no backoff, which
 * is the original freeze condition and why the caller logs it loudly.
 */
export async function recordFailedAttempt(
  counts: { failed: number },
  reasons: Record<string, number>,
  reason: ClassifyFailureReason,
  write: () => PromiseLike<{ error: { message: string } | null }>,
): Promise<string | null> {
  counts.failed++;
  reasons[reason] = (reasons[reason] ?? 0) + 1;
  try {
    const { error } = await write();
    return error ? error.message : null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Strip every failure mark, IN PLACE, and return the same object.
 *
 * Called on the success paths so a row that eventually classifies
 * carries no trace of the outage. In-place (rather than returning a
 * fresh copy) so call sites keep the literal
 * `...(row.metadata_json ?? {})` spread that
 * `src/test/queueInboundClassification.test.ts` reads as source text.
 *
 * CONTRACT: callers MUST pass a fresh object literal, never the row's
 * own `metadata_json` — mutating that would delete keys from the object
 * the rest of the loop still reads. Pinned by
 * `src/test/classifyInboundResilience.test.ts`.
 */
export function stripClassifyMarks(
  meta: Record<string, unknown>,
): Record<string, unknown> {
  for (const k of ALL_KEYS) delete meta[k];
  return meta;
}

/**
 * Pick which fetched rows actually get worked this run.
 *
 * The server-side filter should already have excluded every parked row,
 * so `parked` is normally 0. It is not redundant: the function over-
 * fetches (BATCH_SIZE + headroom) precisely so that if the PostgREST
 * JSON predicate ever stops matching, live rows still get slots instead
 * of the queue re-freezing. A non-zero `parked` is the alarm that the
 * server-side half has stopped working.
 */
export function selectClassifiable<T extends { metadata_json?: Meta }>(
  rows: readonly T[],
  nowIso: string,
  batchSize: number,
): { selected: T[]; parked: number; exhausted: number } {
  const selected: T[] = [];
  let parked = 0;
  let exhausted = 0;
  for (const row of rows) {
    if (isClassifyEligible(row.metadata_json, nowIso)) {
      if (selected.length < batchSize) selected.push(row);
      continue;
    }
    parked++;
    if (isClassifyExhausted(row.metadata_json)) exhausted++;
  }
  return { selected, parked, exhausted };
}
