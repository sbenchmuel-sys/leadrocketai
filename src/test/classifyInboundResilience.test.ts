// ============================================================
// Unit Q1c — classifier resilience.
//
// THE OUTAGE THIS GUARDS AGAINST
// ------------------------------
// `classify-inbound` selected 25 rows a minute in a fully deterministic
// order (`expires_at ASC NULLS LAST, occurred_at ASC`) and, on four of
// its five terminal branches, failed WITHOUT writing anything back to
// the row. With `ai_task` returning HTTP 402 on every call, the same 25
// head-of-queue rows were re-selected, re-failed and abandoned every
// minute for over a week while 1,346 rows behind them starved. Every run
// still reported `ok`.
//
// Behavioural coverage sits on the pure `@shared/classifyRetry` module
// (a vitest spec can import it; `npm run test:edge` cannot run in the
// build sandbox). Source-text guards pin the two things that only exist
// inside the Deno edge function: that the candidate query actually
// applies the server-side backoff filter, and that no failure branch
// writes `intent`.
// ============================================================
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CLASSIFY_ATTEMPTS_KEY,
  CLASSIFY_BACKOFF_MINUTES,
  CLASSIFY_EXHAUSTED_KEY,
  CLASSIFY_LAST_ATTEMPT_KEY,
  CLASSIFY_LAST_ERROR_KEY,
  CLASSIFY_NEVER_ISO,
  CLASSIFY_NEXT_AT_KEY,
  classifyEligibilityFilter,
  stripClassifyMarks,
  isClassifyEligible,
  isClassifyExhausted,
  markClassifyFailure,
  MAX_CLASSIFY_ATTEMPTS,
  readClassifyAttempts,
  selectClassifiable,
} from "@shared/classifyRetry";
import { shouldHideFromQueue } from "@/lib/queueQueries";

const ROOT = path.resolve(__dirname, "../..");
const CLASSIFY_INBOUND = "supabase/functions/classify-inbound/index.ts";
const src = readFileSync(path.join(ROOT, CLASSIFY_INBOUND), "utf8");

const BATCH_SIZE = 25;
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-09-13T09:00:00.000Z");
const MIN = 60_000;

type Row = { id: string; metadata_json: Record<string, unknown> | null };
const row = (id: string, metadata_json: Row["metadata_json"] = null): Row => ({
  id,
  metadata_json,
});

/** The body of `failRow` — the single sanctioned give-up path. */
const failRowBlock = () => {
  const start = src.indexOf("const failRow = async (");
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("\n  try {", start));
};

/** One tick of the cron: filter, then work up to BATCH_SIZE rows. */
const tick = (rows: readonly Row[], atMs: number) =>
  selectClassifiable(rows, iso(atMs), BATCH_SIZE);

// ── 1. A failed row is marked, and is not re-selected immediately ──
describe("a 402 leaves a mark and parks the row", () => {
  it("records attempt count, time and reason code", () => {
    const meta = markClassifyFailure({ from_email: "a@b.com" }, "ai_http_402", iso(T0));

    expect(meta[CLASSIFY_ATTEMPTS_KEY]).toBe(1);
    expect(meta[CLASSIFY_LAST_ATTEMPT_KEY]).toBe(iso(T0));
    expect(meta[CLASSIFY_LAST_ERROR_KEY]).toBe("ai_http_402");
    // Pre-existing metadata survives the merge.
    expect(meta.from_email).toBe("a@b.com");
    // A failure must never write these — see guard 6.
    expect(meta).not.toHaveProperty("intent");
    expect(meta).not.toHaveProperty("sender_is_lead");
  });

  it("is not re-selected on the very next run", () => {
    const failed = row("r1", markClassifyFailure(null, "ai_http_402", iso(T0)));
    // The cron fires again 60 seconds later.
    expect(tick([failed], T0 + MIN).selected).toHaveLength(0);
    expect(tick([failed], T0 + MIN).parked).toBe(1);
  });

  it("backs off further on each successive failure", () => {
    let meta: Record<string, unknown> | null = null;
    const waits: number[] = [];
    for (let n = 1; n <= MAX_CLASSIFY_ATTEMPTS; n++) {
      meta = markClassifyFailure(meta, "ai_http_402", iso(T0));
      expect(readClassifyAttempts(meta)).toBe(n);
      const next = meta[CLASSIFY_NEXT_AT_KEY] as string;
      if (n < MAX_CLASSIFY_ATTEMPTS) waits.push((Date.parse(next) - T0) / MIN);
    }
    // Monotonically non-decreasing — never shrinks back toward 1/minute.
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
    expect(waits[0]).toBe(CLASSIFY_BACKOFF_MINUTES[0]);
  });
});

// ── 2. THE REGRESSION TEST: the head of the queue cannot freeze ────
describe("a failing head-of-queue cannot starve the rows behind it", () => {
  it("still selects a never-attempted row after three rows fail", () => {
    const failedAt = markClassifyFailure(null, "ai_http_402", iso(T0));
    const rows = [
      row("head1", failedAt),
      row("head2", failedAt),
      row("head3", failedAt),
      row("fresh", null), // never attempted, sits behind them in the order
    ];

    const { selected, parked } = tick(rows, T0 + MIN);

    expect(selected.map((r) => r.id)).toEqual(["fresh"]);
    expect(parked).toBe(3);
  });

  it("gives every one of the 25 slots to live rows when the head is parked", () => {
    const parkedMeta = markClassifyFailure(null, "ai_http_402", iso(T0));
    const rows = [
      ...Array.from({ length: 25 }, (_, i) => row(`stuck${i}`, parkedMeta)),
      ...Array.from({ length: 25 }, (_, i) => row(`live${i}`, null)),
    ];

    const { selected, parked } = tick(rows, T0 + MIN);

    expect(parked).toBe(25);
    expect(selected).toHaveLength(BATCH_SIZE);
    expect(selected.every((r) => r.id.startsWith("live"))).toBe(true);
  });

  it("the candidate query applies the backoff filter SERVER-SIDE", () => {
    // Without this the in-memory pass would just shrink the batch to
    // zero and the queue would freeze in a new, quieter way.
    expect(src).toContain("classifyEligibilityFilter");
    expect(src).toMatch(/\.or\(\s*classifyEligibilityFilter\(/);
    // …and the fetch must over-fetch, so a leaked parked row cannot
    // eat a working slot.
    expect(src).toContain("const FETCH_LIMIT = BATCH_SIZE * 2;");
    expect(src).toContain(".limit(FETCH_LIMIT)");
    // If this PostgREST build cannot filter on a JSON path, the run must
    // degrade to the in-memory pass — loudly — not return a hard 500 and
    // do no work at all.
    expect(src).toContain("classify_inbound_backoff_filter_unsupported");
    expect(src).toContain("await candidates(false)");
  });

  it("builds a PostgREST predicate that matches never-attempted rows too", () => {
    const f = classifyEligibilityFilter(iso(T0));
    expect(f).toBe(
      `metadata_json->>classify_next_at.is.null,` +
        `metadata_json->>classify_next_at.lte.${iso(T0)}`,
    );
    // PostgREST splits an or() string on commas — an ISO-8601 timestamp
    // contains none, so the predicate cannot be mis-parsed.
    expect(f.split(",")).toHaveLength(2);
  });

  it("compares ISO timestamps the same way Postgres compares the text", () => {
    // The server-side half compares `metadata_json->>classify_next_at`
    // as TEXT. That only equals chronological order because
    // toISOString() is fixed-width UTC. Prove the two agree.
    const a = iso(T0);
    const b = iso(T0 + 90 * MIN);
    expect(a < b).toBe(true);
    expect(Date.parse(a) < Date.parse(b)).toBe(true);
  });
});

// ── 3. The backlog drains on its own once the gateway is back ──────
describe("a row past its backoff window is picked up again", () => {
  it("becomes eligible after three failures once the window expires", () => {
    let meta: Record<string, unknown> | null = null;
    for (let n = 0; n < 3; n++) meta = markClassifyFailure(meta, "ai_http_402", iso(T0));
    expect(readClassifyAttempts(meta)).toBe(3);

    const nextAt = Date.parse(meta![CLASSIFY_NEXT_AT_KEY] as string);
    const r = row("drains", meta);

    expect(tick([r], nextAt - MIN).selected).toHaveLength(0);
    expect(tick([r], nextAt + MIN).selected.map((x) => x.id)).toEqual(["drains"]);
  });

  it("loses every failure mark once it classifies successfully", () => {
    const meta = markClassifyFailure(
      { from_email: "a@b.com", to_emails: ["rep@us.com"] },
      "ai_http_402",
      iso(T0),
    );

    const cleared = stripClassifyMarks(meta);

    for (const k of [
      CLASSIFY_ATTEMPTS_KEY,
      CLASSIFY_LAST_ATTEMPT_KEY,
      CLASSIFY_LAST_ERROR_KEY,
      CLASSIFY_NEXT_AT_KEY,
      CLASSIFY_EXHAUSTED_KEY,
    ]) {
      expect(cleared).not.toHaveProperty(k);
    }
    // Everything else on the row is untouched.
    expect(cleared.from_email).toBe("a@b.com");
    expect(cleared.to_emails).toEqual(["rep@us.com"]);
    // And it is immediately eligible again (belt: a re-failed row that
    // later succeeds must not stay parked by a stale mark).
    expect(isClassifyEligible(cleared, iso(T0))).toBe(true);
  });

  it("the success paths in the edge function clear the marks", () => {
    expect(src).toContain(
      "metadata_json: stripClassifyMarks({ ...(row.metadata_json ?? {}) })",
    );
    expect(src).toMatch(/metadata_json: stripClassifyMarks\(\{\n\s+\.\.\.\(row\.metadata_json/);
    expect(src).toMatch(/= stripClassifyMarks\(\{\n\s+\.\.\.\(row\.metadata_json/);
  });
});

// ── 4. The retry ceiling gives up WITHOUT damaging the row ─────────
describe("an exhausted row is parked but stays safe", () => {
  const exhausted = (() => {
    let meta: Record<string, unknown> | null = null;
    for (let n = 0; n < MAX_CLASSIFY_ATTEMPTS; n++) {
      meta = markClassifyFailure(meta, "ai_http_402", iso(T0));
    }
    return meta!;
  })();

  it("stops being selected once the ceiling is reached", () => {
    expect(isClassifyExhausted(exhausted)).toBe(true);
    expect(exhausted[CLASSIFY_NEXT_AT_KEY]).toBe(CLASSIFY_NEVER_ISO);
    expect(exhausted[CLASSIFY_EXHAUSTED_KEY]).toBe(iso(T0));

    // Not a year from now, not a century from now.
    const farFuture = Date.parse("2100-01-01T00:00:00.000Z");
    expect(tick([row("dead", exhausted)], farFuture).selected).toHaveLength(0);
    expect(tick([row("dead", exhausted)], farFuture).exhausted).toBe(1);
  });

  it("does NOT become purgeable earlier — intent stays NULL", () => {
    // The purge gate (20260523000000_purge_gate_classified.sql) releases
    // an inbound row's snippet/body once `intent IS NOT NULL`. Writing a
    // give-up intent would purge a customer's email at 72h instead of
    // the 7-day hard cap. So: no intent key, ever, on a failure mark.
    expect(exhausted).not.toHaveProperty("intent");
    expect(exhausted).not.toHaveProperty("intent_version");

    // And the edge function never puts `intent` in a failure update.
    const failBlock = failRowBlock();
    expect(failBlock).toContain("markClassifyFailure(");
    expect(failBlock).not.toMatch(/\bintent:/);
    expect(failBlock).not.toMatch(/\bintent_version:/);
  });

  it("does NOT become hidden in the Queue", () => {
    // shouldHideFromQueue hides on a hide-list intent, reply_worthy ===
    // false, or sender_is_lead === false. An exhausted row carries none
    // of those, so a real customer question stays visible to the rep.
    expect(exhausted).not.toHaveProperty("sender_is_lead");
    expect(exhausted).not.toHaveProperty("ai_signals");
    expect(
      shouldHideFromQueue({ intent: null, reply_worthy: null, sender_is_lead: null }),
    ).toBe(false);
  });
});

// ── 5. Deterministic detectors are untouched by any of this ────────
describe("the deterministic path never depends on the AI gateway", () => {
  it("short-circuits before the ai_task fetch, and before failRow", () => {
    const detectorAt = src.indexOf("detectInboundIntent({");
    const aiAt = src.indexOf("/functions/v1/ai_task");
    const firstAiFail = src.indexOf("await failRow(row, `ai_http_");
    expect(detectorAt).toBeGreaterThan(-1);
    expect(detectorAt).toBeLessThan(aiAt);
    expect(detectorAt).toBeLessThan(firstAiFail);
  });

  it("writes the detector verdict with no AI call in its branch", () => {
    const branch = src.slice(
      src.indexOf("if (deterministic.intent) {"),
      src.indexOf("const aiRes = await fetch("),
    );
    expect(branch).toContain("intent: deterministic.intent");
    expect(branch).toContain("continue;");
    expect(branch).not.toContain("fetch(");
    expect(branch).not.toContain("failRow(row, `ai_http_");
  });

  it("is unaffected by backoff: a never-attempted row is always eligible", () => {
    // Five of the stuck rows are calendar_accept — they only ever
    // needed the detector chain. Nothing in the retry marks can park a
    // row that has never been attempted.
    expect(isClassifyEligible(null, iso(T0))).toBe(true);
    expect(isClassifyEligible({}, iso(T0))).toBe(true);
    expect(isClassifyEligible({ from_email: "x@y.com" }, iso(T0))).toBe(true);
  });
});

// ── 6. Every terminal branch leaves a mark; `skipped` is gone ──────
describe("no terminal branch abandons a row silently", () => {
  it("has no bare `counts.failed++` left outside failRow", () => {
    // failRow is the single place allowed to increment `failed`, and it
    // always writes the attempt record. A bare increment anywhere else
    // is a branch that abandons the row — the original bug.
    const occurrences = src.match(/counts\.failed\+\+/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(failRowBlock()).toContain("counts.failed++");
  });

  it("covers all four previously-silent branches", () => {
    for (const reason of [
      "ai_http_", // AI HTTP error (incl. the 402)
      '"ai_no_content"',
      '"ai_parse_failed"',
      '"ai_summary_missing"',
      '"db_update_failed"',
    ]) {
      expect(src).toContain(`failRow(row, ${reason.startsWith('"') ? reason : "`" + reason}`);
    }
  });

  it("drops the dead `skipped` counter and reports parked instead", () => {
    // No `skipped` field anywhere in the code (prose mentions are fine).
    expect(src).not.toMatch(/\bskipped\s*[:;,]/);
    expect(src).not.toMatch(/counts\.skipped/);
    expect(src).toContain("counts.parked = parked;");
    expect(src).toContain("failure_reasons: failureReasons");
  });
});
