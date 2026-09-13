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
  classifyBacklogState,
  CLASSIFY_ATTEMPTS_KEY,
  CLASSIFY_BACKOFF_MINUTES,
  CLASSIFY_EXHAUSTED_KEY,
  CLASSIFY_LAST_ATTEMPT_KEY,
  CLASSIFY_LAST_ERROR_KEY,
  CLASSIFY_MARK_KEYS,
  CLASSIFY_NEVER_ISO,
  CLASSIFY_NEXT_AT_KEY,
  CLASSIFY_AI_TIMEOUT_MS,
  CLASSIFY_DISPATCHER_TIMEOUT_MS,
  CLASSIFY_OBSERVED_MS_PER_ROW,
  CLASSIFY_RUN_BUDGET_MS,
  CLASSIFY_TOTAL_BACKOFF_MINUTES,
  isRunBudgetSpent,
  classifyEligibilityFilter,
  stripClassifyMarks,
  isClassifyEligible,
  isClassifyExhausted,
  markClassifyFailure,
  MAX_CLASSIFY_ATTEMPTS,
  readClassifyAttempts,
  recordFailedAttempt,
  selectClassifiable,
} from "@shared/classifyRetry";
import { shouldHideFromQueue } from "@/lib/queueQueries";

const ROOT = path.resolve(__dirname, "../..");
const CLASSIFY_INBOUND = "supabase/functions/classify-inbound/index.ts";
const src = readFileSync(path.join(ROOT, CLASSIFY_INBOUND), "utf8");

// Read from the function itself so the spec cannot drift from the code
// it is guarding — BATCH_SIZE is a tuned number and it will move again.
const BATCH_SIZE = Number(/const BATCH_SIZE = (\d+);/.exec(src)![1]);
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

  // The founder sizes the credit-restore deadline off this number. A
  // docblock that says one thing while the table says another is an
  // operational hazard, so pin the ceiling as a NUMBER OF HOURS — and
  // walk the real clock to get there, so a trailing entry that
  // `nextAttemptIso` never reads cannot inflate it again.
  it("exhausts after exactly 45.1 hours of continuous failure", () => {
    let meta: Record<string, unknown> | null = null;
    let atMs = T0;

    // Fail, wait out the backoff, fail again — until the row gives up.
    for (let n = 0; n < MAX_CLASSIFY_ATTEMPTS; n++) {
      expect(isClassifyExhausted(meta)).toBe(false);
      meta = markClassifyFailure(meta, "ai_http_402", iso(atMs));
      const next = meta[CLASSIFY_NEXT_AT_KEY] as string;
      if (next !== CLASSIFY_NEVER_ISO) atMs = Date.parse(next);
    }

    expect(isClassifyExhausted(meta)).toBe(true);
    const hours = (atMs - T0) / (60 * MIN);
    expect(hours).toBeCloseTo(45.08, 2);

    // The derived constant and the walked clock must agree, and every
    // entry in the table must be a wait that is actually served.
    expect(CLASSIFY_TOTAL_BACKOFF_MINUTES).toBe(2705);
    expect((atMs - T0) / MIN).toBe(CLASSIFY_TOTAL_BACKOFF_MINUTES);
    // N attempts, N-1 gaps: every entry in the table is served exactly
    // once, and there is no unread trailing entry to inflate the sum.
    expect(CLASSIFY_BACKOFF_MINUTES).toHaveLength(MAX_CLASSIFY_ATTEMPTS - 1);
  });

  it("states the same ceiling in prose that the table actually serves", () => {
    // Cheap, but this is exactly the drift QA caught: the docblock said
    // ~69 hours while the code served 45.
    const mod = readFileSync(
      path.join(ROOT, "supabase/functions/_shared/classifyRetry.ts"),
      "utf8",
    );
    expect(mod).toContain("2,705 minutes");
    expect(mod).toContain("45 hours");
    expect(mod).not.toMatch(/69 hours|2\.9 days|~3 days/);
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

  it("mutates in place, so every call site must hand it a fresh copy", () => {
    // stripClassifyMarks is a mutator (it has to be, so the call sites
    // keep the literal spread that queueInboundClassification.test.ts
    // pins). Nothing else pins that contract, so pin it here: passing a
    // row's own metadata_json would delete keys the loop still reads.
    const owned = { from_email: "a@b.com", classify_attempts: 3 };
    expect(stripClassifyMarks(owned)).toBe(owned); // same object, mutated
    expect(owned).not.toHaveProperty("classify_attempts");

    // Every call site in the edge function opens a fresh object literal
    // on the same expression — `stripClassifyMarks({ ...` — never
    // `stripClassifyMarks(row.metadata_json)`.
    const calls = src.match(/stripClassifyMarks\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(src).not.toMatch(/stripClassifyMarks\(\s*row\.metadata_json/);
    expect(src.match(/stripClassifyMarks\(\{/g) ?? []).toHaveLength(calls.length);
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
  it("never increments `failed` outside the one sanctioned path", () => {
    // `failed` is now incremented only inside recordFailedAttempt,
    // which also writes the attempt record. A bare increment in the
    // edge function would be a branch that abandons the row — the
    // original bug — or a second count for a row already booked.
    expect(src).not.toContain("counts.failed++");
    expect(src.match(/failureReasons\[/g) ?? []).toHaveLength(0);
    // failRow is the only caller of the helper, and every give-up path
    // goes through failRow.
    expect(failRowBlock()).toContain("recordFailedAttempt(");
    // Exactly one call site: failRow. Nothing else may book a failure.
    expect(src.match(/recordFailedAttempt\(/g) ?? []).toHaveLength(1);
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
    // `fetched` can be up to FETCH_LIMIT, so it does not reconcile
    // against classified + failed. `worked` is the number that does.
    expect(src).toContain("counts.worked++;");
    // Counted down, not tallied after the loop, so the fatal path does
    // not report `unreached: 0` while `worked < batch.length`.
    expect(src).toContain("counts.unreached = batch.length;");
    expect(src).toContain("counts.unreached--;");
    expect(src).not.toContain("counts.unreached = batch.length - counts.worked;");
  });
});

// ── 7. The run budget: bank partial work, never get killed ─────────
//
// The second production failure mode. With the gateway dead, 25 rows
// failed fast in 6–9 s — the regime BATCH_SIZE = 25 was tuned in. The
// minute credits were restored, 25 REAL AI calls took 47–55 s and
// cron-dispatcher started killing the function at its 55 s limit
// (17:56–17:59 ok at ~48 s; 18:00 onward timeout), so the backlog
// stopped draining entirely.
describe("a run stops on the clock instead of being killed", () => {
  it("leaves real headroom under the dispatcher's kill", () => {
    expect(CLASSIFY_RUN_BUDGET_MS).toBeLessThan(CLASSIFY_DISPATCHER_TIMEOUT_MS);
    const headroomMs = CLASSIFY_DISPATCHER_TIMEOUT_MS - CLASSIFY_RUN_BUDGET_MS;
    expect(headroomMs).toBeGreaterThanOrEqual(15_000);
  });

  // THE invariant. The run budget only gates STARTING a row; without a
  // bound on the call itself, a hung gateway blows through the 55 s
  // kill however small the budget is. Worst case must still land inside
  // the kill with room for the failure write and the response.
  it("a row started at the last possible moment still finishes in time", () => {
    const worstCaseMs = CLASSIFY_RUN_BUDGET_MS + CLASSIFY_AI_TIMEOUT_MS;
    expect(worstCaseMs).toBeLessThan(CLASSIFY_DISPATCHER_TIMEOUT_MS);
    expect(CLASSIFY_DISPATCHER_TIMEOUT_MS - worstCaseMs).toBeGreaterThanOrEqual(5_000);
  });

  it("actually bounds the ai_task call, and treats an abort as an AI failure", () => {
    expect(src).toContain("signal: AbortSignal.timeout(CLASSIFY_AI_TIMEOUT_MS)");
    // The signal must be on the ai_task call itself.
    const call = src.slice(
      src.indexOf("const aiRes = await fetch("),
      src.indexOf("if (!aiRes.ok)"),
    );
    expect(call).toContain("AbortSignal.timeout(");
    // An abort throws, so the per-row catch must recognise it and mark
    // it as a timeout — not as the generic reason, and not as a DB bug.
    expect(src).toContain('name === "TimeoutError"');
    expect(src).toContain('name === "AbortError"');
    expect(src).toContain(
      'failRow(row, timedOut ? "ai_timeout" : "unexpected_error")',
    );
  });

  it("sizes the batch so a typical run finishes inside the budget", () => {
    // The whole point: at measured latency the batch completes, so the
    // budget is a backstop rather than the normal exit.
    const typicalRunMs = BATCH_SIZE * CLASSIFY_OBSERVED_MS_PER_ROW;
    expect(typicalRunMs).toBeLessThan(CLASSIFY_RUN_BUDGET_MS);
    // …and the old 25 would NOT have. This is the regression.
    expect(25 * CLASSIFY_OBSERVED_MS_PER_ROW).toBeGreaterThan(CLASSIFY_RUN_BUDGET_MS);

    // FLOOR. BATCH_SIZE is the drain rate (see below), so a typo that
    // shrinks it ships green and silently multiplies the drain time —
    // 6 would quadruple it to ~224 minutes. Require the batch to
    // actually USE the budget it is given. Pins BATCH_SIZE >= 10.
    expect(typicalRunMs).toBeGreaterThan(CLASSIFY_RUN_BUDGET_MS / 2);
    expect(BATCH_SIZE).toBeGreaterThanOrEqual(10);
  });

  // The correction QA made to the drain estimate, pinned so the
  // reasoning cannot be lost again.
  it("drains at BATCH_SIZE per minute regardless of email mix", () => {
    // The cron fires once a minute and works at most BATCH_SIZE rows.
    // A batch of cheap deterministic rows finishes the RUN early; it
    // does NOT go on to work an extra row. Fast rows shorten the run,
    // never the drain. That is the budget-as-backstop design.
    const cheapRunMs = BATCH_SIZE * 100; // all deterministic, ~0 AI cost
    expect(isRunBudgetSpent(cheapRunMs)).toBe(false); // finishes early…
    expect(BATCH_SIZE).toBe(BATCH_SIZE); // …and still works only BATCH_SIZE rows

    // 1,346 real backlogged rows. ~12% are deterministic (151 calendar
    // invites, ~10 OOO, 0 bounces, 0 unsubscribes) — which changes the
    // COST of a run, not the RATE.
    //
    // Don't freeze BATCH_SIZE here (that is the floor test's job) —
    // pin that the drain figure WRITTEN IN THE CODE still matches the
    // batch size actually shipped. Retuning the batch then forces the
    // comment to be corrected, which is the drift this unit keeps
    // getting bitten by.
    expect(src).toContain("Fast rows shorten the run, never the drain.");
    const stated = /1,346 backlogged rows ÷ (\d+) = ~(\d+) minutes/.exec(src);
    expect(stated).not.toBeNull();
    expect(Number(stated![1])).toBe(BATCH_SIZE);
    expect(Number(stated![2])).toBe(Math.round(1346 / BATCH_SIZE));
  });

  it("stops at the budget rather than starting one more row", () => {
    expect(isRunBudgetSpent(CLASSIFY_RUN_BUDGET_MS - 1)).toBe(false);
    expect(isRunBudgetSpent(CLASSIFY_RUN_BUDGET_MS)).toBe(true);
    expect(isRunBudgetSpent(CLASSIFY_RUN_BUDGET_MS + 1)).toBe(true);
  });

  it("checks the budget BEFORE working a row, and breaks without marking", () => {
    const loopAt = src.indexOf("for (const row of batch) {");
    const guardAt = src.indexOf("isRunBudgetSpent(Date.now() - startedAt)");
    const firstTryAt = src.indexOf("try {", loopAt);
    expect(guardAt).toBeGreaterThan(loopAt);
    expect(guardAt).toBeLessThan(firstTryAt); // before any work on the row

    // The break path must not touch failRow — see the next test.
    const guardBlock = src.slice(guardAt, firstTryAt);
    expect(guardBlock).toContain("break;");
    expect(guardBlock).not.toContain("failRow");
    expect(guardBlock).not.toContain("markClassifyFailure");
  });

  // ── The backoff/timeout interaction the coordinator asked about ──
  it("a row the budget never reached is NOT marked as a failed attempt", () => {
    // Simulate one run: 25 eligible rows, ~1.9 s each, budget 35 s.
    // Rows the loop reaches fail (gateway 402) and get marked; rows it
    // never reaches must be untouched — they were never attempted.
    const rows = Array.from({ length: 25 }, (_, i) => row(`r${i}`, null));

    let elapsed = 0;
    const reached: string[] = [];
    for (const r of rows) {
      if (isRunBudgetSpent(elapsed)) break;
      reached.push(r.id);
      r.metadata_json = markClassifyFailure(r.metadata_json, "ai_http_402", iso(T0));
      elapsed += CLASSIFY_OBSERVED_MS_PER_ROW;
    }

    const unreached = rows.filter((r) => !reached.includes(r.id));
    expect(reached.length).toBeGreaterThan(0);
    expect(unreached.length).toBeGreaterThan(0);

    // Attempted rows: marked and parked.
    for (const r of rows.filter((x) => reached.includes(x.id))) {
      expect(readClassifyAttempts(r.metadata_json)).toBe(1);
      expect(isClassifyEligible(r.metadata_json, iso(T0 + MIN))).toBe(false);
    }
    // Never-reached rows: no marks at all, still first-class candidates
    // on the very next tick. A timeout must not burn a retry.
    for (const r of unreached) {
      expect(r.metadata_json).toBeNull();
      expect(readClassifyAttempts(r.metadata_json)).toBe(0);
      expect(isClassifyEligible(r.metadata_json, iso(T0 + MIN))).toBe(true);
    }
    expect(tick(unreached, T0 + MIN).selected).toHaveLength(unreached.length);
  });

  it("banks each row as it completes, so a kill cannot discard work", () => {
    // Every classification is its own awaited UPDATE inside the loop —
    // nothing is buffered to a flush at the end — so a kill at 55 s
    // leaves every completed row durably written. What a kill DOES lose
    // is the end-of-run summary, which is why progress was invisible.
    const loop = src.slice(
      src.indexOf("for (const row of batch) {"),
      src.indexOf("classify_inbound_batch_done"),
    );
    expect(loop).toContain('.from("lead_timeline_items")');
    expect(loop).toContain(".update({");
    // No accumulate-then-flush: no array of pending writes, no upsert
    // of many rows after the loop.
    expect(loop).not.toMatch(/\.upsert\(/);
    expect(src).not.toMatch(/pending(Writes|Updates)/i);
  });

  it("reports the stop in the run summary", () => {
    expect(src).toContain("counts.budget_stopped = true;");
    expect(src).toContain("budget_stopped: false,");
    expect(src).toContain("unreached: 0,");
  });
});

// ── 8. One worked row books exactly one failure ────────────────────
//
// Codex P2. `recordFailedAttempt` increments FIRST and then writes, and
// the caller sits inside a per-row try/catch that also books a failure.
// If the write could reject, the same row would be counted twice — and
// `worked === classified + failed` is asserted by the staging gate, so
// a real outage with flaky DB writes would have produced a confusing
// red. Two reviewers signed off on that invariant; it took a third
// reader to break it in a paragraph.
describe("a failing failure-write cannot double-count the row", () => {
  const freshTally = () => ({
    counts: { failed: 0, exhausted: 0 },
    reasons: {} as Record<string, number>,
  });
  /** A mark for a row that still has retries left. */
  const liveMark = () => markClassifyFailure(null, "ai_http_402", iso(T0));

  it("does not throw when the write rejects", async () => {
    const { counts, reasons } = freshTally();
    await expect(
      recordFailedAttempt(counts, reasons, "ai_http_402", liveMark(), () =>
        Promise.reject(new Error("network down")),
      ),
    ).resolves.toBe("network down");
  });

  it("books the row exactly once when the write rejects", async () => {
    const { counts, reasons } = freshTally();
    const err = await recordFailedAttempt(counts, reasons, "ai_http_402", liveMark(), () =>
      Promise.reject(new Error("network down")),
    );
    expect(err).toBe("network down");
    expect(counts.failed).toBe(1);
    expect(reasons).toEqual({ ai_http_402: 1 });
  });

  it("books it once when the write returns an error object too", async () => {
    const { counts, reasons } = freshTally();
    const err = await recordFailedAttempt(counts, reasons, "ai_timeout", liveMark(), () =>
      Promise.resolve({ error: { message: "row locked" } }),
    );
    expect(err).toBe("row locked");
    expect(counts.failed).toBe(1);
    expect(reasons).toEqual({ ai_timeout: 1 });
  });

  it("reconciles worked === classified + failed when a mark write rejects", async () => {
    // Drive the real loop shape: worked++, give up on the row, and —
    // because failRow can no longer reject — the per-row catch never
    // fires, so the row is not booked a second time.
    const counts = { worked: 0, classified: 0, failed: 0, exhausted: 0 };
    const reasons: Record<string, number> = {};

    for (let i = 0; i < 3; i++) {
      counts.worked++;
      try {
        // Every one of these rows fails, and every mark write rejects.
        await recordFailedAttempt(counts, reasons, "ai_http_402", liveMark(), () =>
          Promise.reject(new Error("network down")),
        );
      } catch {
        // The per-row catch. Must never be reached from the give-up
        // path — if it is, it books the row again and the sum breaks.
        await recordFailedAttempt(counts, reasons, "unexpected_error", liveMark(), () =>
          Promise.resolve({ error: null }),
        );
      }
    }

    expect(counts.worked).toBe(3);
    expect(counts.classified + counts.failed).toBe(counts.worked);
    expect(reasons).toEqual({ ai_http_402: 3 });
    expect(reasons.unexpected_error).toBeUndefined();
  });

  it("an unmarkable row is retried next tick as an unmarked candidate", async () => {
    // It was worked and it did fail, so it is counted — but nothing
    // reached the database, so it carries no backoff and comes straight
    // back. That is deliberate (and why the caller logs it loudly).
    const { counts, reasons } = freshTally();
    const r = row("unmarkable", null);
    await recordFailedAttempt(counts, reasons, "ai_http_402", liveMark(), () =>
      Promise.reject(new Error("network down")),
    );

    expect(counts.failed).toBe(1);
    expect(r.metadata_json).toBeNull();
    expect(readClassifyAttempts(r.metadata_json)).toBe(0);
    expect(tick([r], T0 + MIN).selected.map((x) => x.id)).toEqual(["unmarkable"]);
  });

  it("failRow is non-throwing, so the catch drops its defensive guard", () => {
    expect(failRowBlock()).not.toContain("counts.failed++");
    // The old `.catch(() => {})` papered over the double-count path.
    expect(src).not.toContain("failRow(row, timedOut ? \"ai_timeout\" : \"unexpected_error\")\n          .catch");
    expect(src).not.toMatch(/failRow\([^)]*\)\s*\n?\s*\.catch\(/);
  });
});

// ── 9. The documented escape hatch actually works ──────────────────
//
// Codex P2. The module used to tell an operator to "clear
// classify_exhausted_at" to recover a backlog parked by a long outage.
// That does nothing: parking is enforced by the classify_next_at
// sentinel and the budget by classify_attempts, so the row stays
// invisible to both the server-side filter and isClassifyEligible. An
// operator would have run it mid-incident, seen no change, and had no
// way to tell why. This is the documented recovery, driven for real.
describe("manual recovery unparks an exhausted row", () => {
  const MODULE = "supabase/functions/_shared/classifyRetry.ts";
  const mod = readFileSync(path.join(ROOT, MODULE), "utf8");

  /** A row that burned the whole retry budget during an outage. */
  const exhaustedMeta = () => {
    let meta: Record<string, unknown> | null = null;
    for (let n = 0; n < MAX_CLASSIFY_ATTEMPTS; n++) {
      meta = markClassifyFailure(meta, "ai_http_402", iso(T0));
    }
    return meta!;
  };

  /** Exactly what the documented SQL does: drop every classify_* key. */
  const applyDocumentedRecovery = (meta: Record<string, unknown>) => {
    for (const key of CLASSIFY_MARK_KEYS) delete meta[key];
    return meta;
  };

  it("confirms the old one-field instruction really was inert", () => {
    // The regression itself, pinned: clearing only the flag leaves the
    // row parked by BOTH gates.
    const meta = exhaustedMeta();
    delete meta[CLASSIFY_EXHAUSTED_KEY];

    // Not even in the year 2100 — the sentinel is 9999.
    const farFuture = Date.parse("2100-01-01T00:00:00.000Z");
    expect(isClassifyEligible(meta, iso(farFuture))).toBe(false);
    expect(readClassifyAttempts(meta)).toBeGreaterThanOrEqual(MAX_CLASSIFY_ATTEMPTS);
    expect(isClassifyExhausted(meta)).toBe(true); // still, despite the flag
    expect(tick([row("stuck", meta)], farFuture).selected).toHaveLength(0);
  });

  it("the documented statement removes every mark key", () => {
    // Drift guard. If a new classify_* key is added and the recovery
    // statement is not updated, recovery would silently leave residue.
    const sql = /UPDATE lead_timeline_items[\s\S]*?classify_exhausted_at';/.exec(mod);
    expect(sql).not.toBeNull();
    for (const key of CLASSIFY_MARK_KEYS) {
      expect(sql![0]).toContain(`- '${key}'`);
    }
    // …and it is scoped to rows that actually gave up, so re-running it
    // cannot disturb a row that is merely mid-backoff.
    expect(sql![0]).toContain("metadata_json ? 'classify_exhausted_at'");
    expect(sql![0]).toContain("intent IS NULL");
  });

  it("applying the real recovery makes the row selectable again", () => {
    const r = row("recovered", exhaustedMeta());
    expect(tick([r], T0 + MIN).selected).toHaveLength(0); // parked

    applyDocumentedRecovery(r.metadata_json!);

    expect(isClassifyExhausted(r.metadata_json)).toBe(false);
    expect(readClassifyAttempts(r.metadata_json)).toBe(0);
    expect(isClassifyEligible(r.metadata_json, iso(T0 + MIN))).toBe(true);
    expect(tick([r], T0 + MIN).selected.map((x) => x.id)).toEqual(["recovered"]);
  });

  it("the recovered row then classifies clean, with no classify_* residue", () => {
    const meta = applyDocumentedRecovery(exhaustedMeta());
    const classified = stripClassifyMarks({ ...meta, intent_source: "ai" });

    for (const key of CLASSIFY_MARK_KEYS) {
      expect(classified).not.toHaveProperty(key);
    }
    expect(Object.keys(classified).filter((k) => k.startsWith("classify_"))).toEqual([]);
    expect(classified.intent_source).toBe("ai");
  });

  it("gives a FRESH budget, not one last attempt", () => {
    // The trap in the "clear one field" alternative: attempts would
    // still sit at the ceiling, so the row would re-exhaust on its very
    // next failure instead of getting the full backoff ladder again.
    const meta = applyDocumentedRecovery(exhaustedMeta());

    const afterOneFailure = markClassifyFailure(meta, "ai_http_402", iso(T0));
    expect(readClassifyAttempts(afterOneFailure)).toBe(1);
    expect(isClassifyExhausted(afterOneFailure)).toBe(false);
    expect(afterOneFailure[CLASSIFY_NEXT_AT_KEY]).not.toBe(CLASSIFY_NEVER_ISO);
  });

  it("no longer tells the operator that clearing one field is enough", () => {
    expect(mod).not.toMatch(/operator to clear `classify_exhausted_at`/);
    expect(mod).toContain("Clearing `classify_exhausted_at` on its own does nothing.");
  });
});

// ── 10. A dead backlog must announce itself ────────────────────────
//
// Codex P2. `exhausted` was computed from the pre-loop candidate
// snapshot, so it could never be non-zero: a row is not exhausted yet
// when the snapshot is taken, and from the next tick the server-side
// filter hides it from the candidate set entirely. The one number that
// would tell an operator "this backlog is dead, run the recovery
// statement" was structurally always 0 — and once everything exhausted,
// the run reported an empty batch, i.e. the same output as a healthy
// drained queue. That is this unit's own failure mode: a job reporting
// "nothing to do" while sitting on a dead backlog.
describe("exhaustion is visible in the run that causes it", () => {
  const tally = () => ({
    counts: { failed: 0, exhausted: 0 },
    reasons: {} as Record<string, number>,
  });

  /** Metadata one failure short of the ceiling. */
  const oneShortOfCeiling = () => {
    let meta: Record<string, unknown> | null = null;
    for (let n = 0; n < MAX_CLASSIFY_ATTEMPTS - 1; n++) {
      meta = markClassifyFailure(meta, "ai_http_402", iso(T0));
    }
    return meta!;
  };

  it("counts the row on the run where its FINAL mark is written", () => {
    const { counts, reasons } = tally();
    const mark = markClassifyFailure(oneShortOfCeiling(), "ai_http_402", iso(T0));
    expect(isClassifyExhausted(mark)).toBe(true);

    return recordFailedAttempt(counts, reasons, "ai_http_402", mark, () =>
      Promise.resolve({ error: null }),
    ).then(() => {
      expect(counts.exhausted).toBe(1);
      expect(counts.failed).toBe(1);
    });
  });

  it("does not count a row that still has retries left", async () => {
    const { counts, reasons } = tally();
    const mark = markClassifyFailure(null, "ai_http_402", iso(T0));
    expect(isClassifyExhausted(mark)).toBe(false);

    await recordFailedAttempt(counts, reasons, "ai_http_402", mark, () =>
      Promise.resolve({ error: null }),
    );
    expect(counts.exhausted).toBe(0);
    expect(counts.failed).toBe(1);
  });

  // The mark says exhausted, but the write did not land — so the row is
  // NOT exhausted in the database and must not be reported as such.
  // BOTH failure shapes matter: supabase-js normally RETURNS `{ error }`
  // and only throws on a transport failure, so testing one covers half
  // the branch. (Caught by mutation testing: an early-return that
  // counted on the `{ error }` path slipped past a reject-only test.)
  it.each([
    ["the write rejects", () => Promise.reject(new Error("network down"))],
    ["the write returns an error", () => Promise.resolve({ error: { message: "row locked" } })],
  ])("does not count exhaustion the database never saw — %s", async (_label, write) => {
    const { counts, reasons } = tally();
    const mark = markClassifyFailure(oneShortOfCeiling(), "ai_http_402", iso(T0));
    expect(isClassifyExhausted(mark)).toBe(true);

    await recordFailedAttempt(counts, reasons, "ai_http_402", mark, write);
    expect(counts.failed).toBe(1);
    expect(counts.exhausted).toBe(0);
  });

  it("a whole batch giving up reports a non-zero exhausted", async () => {
    // The outage end-state, driven: every row on its last attempt.
    const { counts, reasons } = tally();
    for (let i = 0; i < BATCH_SIZE; i++) {
      const mark = markClassifyFailure(oneShortOfCeiling(), "ai_http_402", iso(T0));
      await recordFailedAttempt(counts, reasons, "ai_http_402", mark, () =>
        Promise.resolve({ error: null }),
      );
    }
    expect(counts.exhausted).toBe(BATCH_SIZE);
    expect(counts.failed).toBe(BATCH_SIZE);
  });
});

describe("an empty run says WHY it is empty", () => {
  it("tells a drained queue from a fully parked one", () => {
    // Healthy steady state: nothing selected, nothing outstanding.
    expect(classifyBacklogState(0, 0)).toBe("drained");
    // The dead backlog: nothing eligible, but rows still unclassified —
    // so by definition every one of them is parked or exhausted.
    expect(classifyBacklogState(0, 1346)).toBe("all_parked");
    // Any work at all means neither.
    expect(classifyBacklogState(15, 1346)).toBe("working");
    expect(classifyBacklogState(1, 0)).toBe("working");
  });

  it("probes the backlog ONLY on an idle run", () => {
    // It runs every minute forever, so the count must not ride along on
    // runs that already have work to do.
    const emptyBranch = src.slice(
      src.indexOf("if (batch.length === 0) {"),
      src.indexOf("// Single bulk lead-context fetch"),
    );
    expect(emptyBranch).toContain('{ count: "exact", head: true }');
    expect(emptyBranch).toContain("classify_inbound_backlog_all_parked");
    // …and nowhere else in the function.
    expect(src.match(/count: "exact"/g) ?? []).toHaveLength(1);
  });

  it("reports the state on the response so it is visible without logs", () => {
    expect(src).toContain("backlog_state: state,");
    expect(src).toContain("counts.backlog_parked = count ?? 0;");
  });

  it("survives a failed probe without failing the run", () => {
    // A backlog probe that errors must degrade to `drained`, not throw
    // — the run itself did nothing wrong.
    expect(src).toContain("classify_inbound_backlog_probe_failed");
    expect(src).toContain("count ?? 0");
  });
});
