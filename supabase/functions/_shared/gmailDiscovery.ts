// ============================================================
// gmailDiscovery — which Gmail threads gmail-bulk-sync considers,
// and which of them it expands this run.
//
// THE STARVATION THIS CLOSES (Unit G-B P1)
//
// Discovery used `from:<lead> OR to:<lead>`: any message with the lead in a
// header. That admits a colleague of the lead writing to the rep with the lead
// copied, list mail both are on, tooling notifications naming the lead — every
// thread the direct-conversation gate then correctly REJECTS. But rejection
// wrote nothing, so a rejected thread was indistinguishable from a never-synced
// one, sorted to the front of the expansion queue, and won one of the 25 slots
// again on every run. With more than 25 such threads a genuine older rep↔lead
// thread was never expanded — while the automation kept emailing a contact
// whose reply was sitting in it.
//
// Same lesson as the Outlook candidate cap: a capped scan plus a refusal that
// leaves the row in place is a permanent starvation. A refusal must MOVE the
// row or MARK it — or, best, never let it into the pool. Here the pool is a
// Gmail search, and Gmail can apply the gate's own predicate server-side:
//
//     (from:<lead> to:<rep>) OR (from:<rep> to:<lead>)
//
// is `isDirectConversation` expressed as a query. Third-party threads never
// enter `lockedThreadIds`, never consume a slot, and there is no rejection to
// leave a trace of. Zero extra API calls.
//
// Pure — no client, no I/O — so a vitest spec drives the real selection.
// ============================================================

/**
 * The discovery query. Direct rep↔lead only.
 *
 * Gmail's `from:` / `to:` match headers only (To, not Cc — the same To-only
 * rule the per-message gate applies), so this cannot return a DSN: a bounce is
 * from postmaster with the lead only in the body, and the OLD query could not
 * find one either. Bounces still reach the bounce handler the way they always
 * did in bulk-sync — inside a thread that was discovered via its original
 * direct message.
 *
 * FAIL-OPEN ON A BLANK REP ADDRESS, deliberately: with no rep address the gate
 * downstream rejects everything anyway (fail-closed), and the cron path skips
 * the connection before getting here. Falling back to the broad query keeps the
 * request well-formed; it cannot store anything the gate will not pass.
 */
export function gmailDirectDiscoveryQuery(leadEmail: string, repEmail: string): string {
  const lead = leadEmail.trim().toLowerCase();
  const rep = repEmail.trim().toLowerCase();
  if (!rep) return `from:"${lead}" OR to:"${lead}"`;
  return `(from:"${lead}" to:"${rep}") OR (from:"${rep}" to:"${lead}")`;
}

/**
 * Which threads to expand this run.
 *
 * Never-synced threads first — recent activity in known threads is already
 * covered by the newest-page per-message pass, so the scarce slots go to
 * threads we have never seen. Order within each group is the caller's
 * (discovery order = newest first). Deterministic; never mutates the input.
 *
 * With the query above, every thread in `threadIds` is a direct rep↔lead
 * thread, so every expansion writes at least one row and the thread becomes
 * "previously synced" for the next run. A lead with more than `cap`
 * never-synced direct threads is therefore worked through PROGRESSIVELY, `cap`
 * per run — not starved.
 */
export function selectThreadsToExpand(
  threadIds: Iterable<string>,
  previouslySynced: ReadonlySet<string>,
  cap: number,
): string[] {
  return Array.from(threadIds)
    .sort((a, b) => (previouslySynced.has(a) ? 1 : 0) - (previouslySynced.has(b) ? 1 : 0))
    .slice(0, cap);
}
