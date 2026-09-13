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
 * Backoff after the Nth consecutive failure, in minutes. Index 0 is
 * "after the 1st failure". The length of this array IS the retry
 * ceiling: once `classify_attempts` reaches it, the row is exhausted.
 *
 * Total wall-clock before exhaustion: 5m + 15m + 45m + 2h + 6h + 12h +
 * 24h + 24h ≈ 69 hours ≈ 2.9 days of continuous gateway failure.
 *
 * ponytail: a fixed table beats a formula here — the numbers are the
 * product decision ("how long do we keep paying for a doomed retry"),
 * and reading them off one line is worth more than deriving them.
 * Ceiling: an outage longer than ~3 days parks the backlog permanently
 * and it needs an operator to clear `classify_exhausted_at`.
 */
export const CLASSIFY_BACKOFF_MINUTES: readonly number[] = [
  5, 15, 45, 120, 360, 720, 1440, 1440,
];

export const MAX_CLASSIFY_ATTEMPTS = CLASSIFY_BACKOFF_MINUTES.length;

/**
 * Sentinel written to `classify_next_at` once a row is exhausted. Being
 * a real (far-future) ISO timestamp means the ONE server-side filter
 * excludes both parked and exhausted rows — no second predicate.
 */
export const CLASSIFY_NEVER_ISO = "9999-12-31T00:00:00.000Z";

/** Short, stable reason codes stored in `classify_last_error`. */
export type ClassifyFailureReason =
  | `ai_http_${number}`
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
 * Strip every failure mark, IN PLACE, and return the same object.
 *
 * Called on the success paths so a row that eventually classifies
 * carries no trace of the outage. In-place (rather than returning a
 * fresh copy) so call sites keep the literal
 * `...(row.metadata_json ?? {})` spread that
 * `src/test/queueInboundClassification.test.ts` reads as source text.
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
