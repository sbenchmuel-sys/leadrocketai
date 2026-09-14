// ============================================================
// leadResolution — when one email address matches several lead
// rows in the same workspace, which one is the conversation?
//
// A workspace legitimately holds more than one lead row for an address:
// re-imported lists, a contact re-added for a second deal, a merge that never
// happened. Measured on production 2026-09-14: 6 such groups, 14 rows — 4
// groups where NO row has automation armed, 1 with exactly one, 1 with SEVERAL.
// All three shapes are real.
//
// WHY THIS MATTERS (Unit G-B P1)
//
// The Outlook webhook used to resolve the duplicate with
// `.order("created_at").limit(1)` — the OLDEST row. That stopped
// `maybeSingle()` erroring on duplicates, which was the point, but oldest-first
// is close to the worst available answer: the row carrying the live campaign is
// usually the NEWER one. So the customer's reply, and the instant-pause that is
// supposed to ride with it, both landed on a dormant duplicate — while the
// active row carried on emailing someone who had just written back.
//
// Two rules come out of that, and the second is the one that makes the first
// non-critical:
//
//   1. ATTRIBUTION goes to the most-live row (`pickPrimaryLead`), so the reply
//      appears where the rep is actually working.
//   2. GUARDRAILS — pause, opt-out, bounce-stop — are applied to EVERY matching
//      row (`orderLeadsByLiveness` returns them all). A dormant row losing an
//      automation it was not running costs nothing; an armed row not being
//      paused costs a customer. So a wrong tiebreak is now a cosmetic problem,
//      not "keeps emailing a customer who replied".
//
// Pure — no client, no I/O — so a vitest spec exercises the real ordering.
// ============================================================

/** The columns the ordering reads. Extra fields on the row are ignored. */
export interface LeadLikeRow {
  id: string;
  unsubscribed?: boolean | null;
  /** Non-null means automation is armed — this is the row that can still send. */
  automation_mode?: string | null;
  nurture_status?: string | null;
  last_activity_at?: string | null;
  created_at?: string | null;
}

/** Epoch ms, with "missing or unparseable" sorting as oldest-possible. */
function time(value: string | null | undefined): number {
  if (!value) return -Infinity;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * Newest-first comparison that is safe for the sentinel above.
 *
 * NOT `b - a`: two missing timestamps give `-Infinity - -Infinity`, which is
 * NaN, and a comparator that returns NaN makes Array.sort's result undefined —
 * so the rows came back in an arbitrary order and the "no signal at all" and
 * "identical rows" cases silently stopped being deterministic.
 */
function newerFirst(a: number, b: number): number {
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

/**
 * Order duplicate lead rows most-live first.
 *
 * The comparisons, in order, and why each one is where it is:
 *   1. NOT unsubscribed beats unsubscribed — a stopped row is not the
 *      conversation.
 *   2. Automation ARMED beats not armed — this is the row that can still send
 *      mail to someone who just replied, so it is the row a rep is watching.
 *   3. Active nurture beats inactive — same reasoning, weaker signal.
 *   4. More recent `last_activity_at` — actual evidence of which row is in use.
 *   5. More recently CREATED — the deliberate reversal of the old rule. When a
 *      contact is re-added for a new deal the new row is the live one.
 *   6. `id` — so the result is total and stable, never arbitrary.
 *
 * Never mutates the input.
 */
export function orderLeadsByLiveness<T extends LeadLikeRow>(rows: readonly T[]): T[] {
  const score = (r: T): number[] => [
    r.unsubscribed ? 1 : 0,
    r.automation_mode ? 0 : 1,
    r.nurture_status === "active" ? 0 : 1,
  ];

  return [...rows].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) {
      if (sa[i] !== sb[i]) return sa[i] - sb[i];
    }
    const act = newerFirst(time(a.last_activity_at), time(b.last_activity_at));
    if (act !== 0) return act;
    const created = newerFirst(time(a.created_at), time(b.created_at));
    if (created !== 0) return created;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * The row an inbound message should be ATTRIBUTED to.
 *
 * NO MATCH  → null. The caller must treat that as "not our lead" and do
 *             nothing; there is no fallback to a different workspace, and no
 *             guessing. (The workspace scoping upstream is what makes "no
 *             match" meaningful rather than a lookup failure.)
 * ONE MATCH → that row, unchanged behaviour.
 * MANY      → the most-live row per `orderLeadsByLiveness`. Deterministic even
 *             when every row looks identical, because the final comparison is
 *             on `id`. The other rows are NOT ignored — the caller applies the
 *             guardrails to all of them.
 */
export function pickPrimaryLead<T extends LeadLikeRow>(rows: readonly T[]): T | null {
  if (rows.length === 0) return null;
  return orderLeadsByLiveness(rows)[0];
}
