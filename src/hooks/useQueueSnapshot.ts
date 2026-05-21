// ============================================================
// useQueueSnapshot — Queue page data + new-items banner.
//
// Snapshot semantics (brief §8):
//   • Initial query on mount → seed snapshot (the list the rep
//     actually works) AND remember its count.
//   • 30s interval → COUNT-ONLY recount (not a full re-fetch). The
//     list does not change under the rep's cursor.
//   • If the recount differs from the snapshot count, expose
//     `newItemsDelta`. The component shows the banner; clicking
//     refresh calls `refresh()` which does a full re-fetch.
//
// Why a separate poll path: brief §8 explicitly forbids letting React
// re-render the underlying list on every tick. Reordering rows under
// the rep's cursor breaks the "morning ritual" trust contract.
//
// The hook owns:
//   - snapshot (the list)
//   - hiddenCount (for the "N routine items hidden · show all" header)
//   - loading state
//   - currentCount — see invariant below
//   - newItemsDelta = currentCount - (snapshot filtered by chip).length.
//                     Positive when fresh leads have entered since
//                     snapshot, negative when leads have been handled
//                     or snoozed out elsewhere. The banner shows the
//                     absolute delta but only when nonzero.
//
// Brief §8 also says: "Do not try to be clever about WHICH items are
// new — just the count delta." So this hook intentionally does not
// diff lead IDs.
//
// showAll (PR D, Codex P1):
//   When the rep flips "show all", we re-snapshot with the intent-hide
//   filter disabled. The count poll deliberately stays on the unhidden
//   set so the new-items banner means "new items in your normal queue"
//   regardless of debug-view state. The cost: under showAll=true the
//   delta can read non-zero even when nothing changed (poll counts
//   unhidden, snapshot includes hidden). Acceptable trade-off — show-
//   all is debug mode, the rep can refresh.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchQueueLeads,
  fetchVisibleQueueLeadsCount,
  applyChipFilter,
  chipForLead,
  type QueueLeadRow,
  type QueueChipBucket,
} from "@/lib/queueQueries";

const POLL_INTERVAL_MS = 30_000;

export interface QueueSnapshot {
  /** Stable snapshot — does not reorder while the rep works the queue. */
  snapshot: QueueLeadRow[];
  /** Count of leads hidden by the intent filter (drives "N routine items hidden"). */
  hiddenCount: number;
  /**
   * INVARIANT: `currentCount` must reflect the server's view modulo
   * any optimistic mutations not yet polled. Sources that may update
   * it, in priority order:
   *   1. `refresh()`             — full re-snapshot; authoritative.
   *   2. 30s poll                — periodic server reconciliation.
   *   3. `chip` change effect    — recomputes from current snapshot.
   *   4. `removeLead` / `restoreLead` — optimistic ±1 (Codex P2).
   * If a future agent adds another mutation path, that path MUST keep
   * `currentCount` in sync or the "N new items — refresh" banner will
   * drift and lie to the rep.
   */
  currentCount: number;
  /** Initial load only. Subsequent refreshes set this false to keep the list visible. */
  isLoading: boolean;
  /** Most recent error message from a failed list fetch (null when ok). */
  error: string | null;
  /**
   * delta = currentCount - (snapshot filtered by chip).length. Nonzero
   * triggers the "N new items — refresh" banner. Sign is preserved so
   * the banner can show "−2" if items dropped (though brief §8 mentions
   * only the positive case; we treat any nonzero delta as actionable).
   */
  newItemsDelta: number;
  /** Trigger a full re-fetch and re-snapshot. Clears `newItemsDelta`. */
  refresh: () => Promise<void>;
  /**
   * Optimistically remove a lead from the snapshot (used by Mark
   * Handled / Snooze before the RPC completes). Card disappears
   * immediately; `restoreLead` puts it back if the RPC fails or the
   * rep clicks Undo. Takes the full lead row so the hook can decide
   * whether to also decrement `currentCount` (i.e. whether the lead
   * would have counted toward the current chip filter — Codex P2).
   */
  removeLead: (lead: QueueLeadRow) => void;
  /** Restore an optimistically-removed lead in its original position. */
  restoreLead: (lead: QueueLeadRow) => void;
}

interface UseQueueSnapshotOpts {
  /** Chip filter — the count poll reflects this filter so the banner
   *  shows "N new items" relative to what the rep is actually viewing. */
  chip: QueueChipBucket | null;
  /**
   * When true the snapshot includes leads the intent-hide rule would
   * normally drop. Flipping this triggers a re-snapshot — see Codex P1
   * (the hook previously always fetched with showAll: false, so the
   * "show all" affordance only worked when the snapshot happened to
   * already contain those leads, which after PR D it never did).
   */
  showAll: boolean;
}

/** Predicate: does this lead count toward the chip-filtered view? */
function leadMatchesChip(lead: QueueLeadRow, chip: QueueChipBucket | null): boolean {
  if (chip == null) return true;
  return (
    chipForLead({
      next_action_key: lead.next_action_key,
      action_resurfaced_at: lead.action_resurfaced_at,
    }) === chip
  );
}

export function useQueueSnapshot(opts: UseQueueSnapshotOpts): QueueSnapshot {
  const { chip, showAll } = opts;

  const [snapshot, setSnapshot] = useState<QueueLeadRow[]>([]);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentCount, setCurrentCount] = useState(0);

  // We track the lead order at snapshot time so optimistic restore
  // puts the card back in its rightful row (not at the end). The
  // alternative — a Map<id, row> — loses ordering.
  const snapshotOrderRef = useRef<string[]>([]);

  // Mirror of `snapshot` for synchronous reads from callbacks that
  // can't safely close over state (chip-change effect, mutation
  // callbacks). Updated atomically inside every setSnapshot call so
  // the ref never lags React's view by more than the same render.
  const snapshotRef = useRef<QueueLeadRow[]>([]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const { leads, hiddenCount: hc } = await fetchQueueLeads({ showAll });
      setSnapshot(leads);
      snapshotRef.current = leads;
      setHiddenCount(hc);
      snapshotOrderRef.current = leads.map((l) => l.id);
      // Authoritative reset of `currentCount` — full re-fetch trumps
      // any optimistic state from before refresh.
      setCurrentCount(applyChipFilter(leads, chip).length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      console.error("[useQueueSnapshot] refresh failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, [chip, showAll]);

  // Initial mount AND re-snapshot when `showAll` toggles. Chip is
  // deliberately NOT in the dep list — chip is a client-side filter
  // applied to the existing snapshot, not a refetch trigger (brief §8
  // forbids re-render-on-chip).
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAll]);

  // Background poll. Lightweight count-only query. Updates
  // `currentCount`; component derives the banner from
  // `newItemsDelta` so we never mutate the snapshot here.
  //
  // The poll always queries with the unhidden set (fetchVisibleQueueLeadsCount
  // delegates to fetchQueueLeads({ showAll: false }) under the hood),
  // even when the rep has show-all flipped on. That matches the
  // operator-stated intent: the banner is about "real work that's
  // changing", not about debug-view state.
  useEffect(() => {
    const tick = async () => {
      try {
        const next = await fetchVisibleQueueLeadsCount({ chip });
        setCurrentCount(next);
      } catch (err) {
        // Polling errors are non-fatal — just skip this tick. Don't
        // surface to the user; the next tick may succeed.
        console.warn("[useQueueSnapshot] poll failed:", err);
      }
    };
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [chip]);

  // When the chip changes, the snapshot stays the same but the
  // "currently visible count" shifts. Recompute it from the snapshot
  // ref so the banner doesn't immediately misfire while we wait for
  // the next poll. snapshotRef (not state) so this doesn't fire on
  // every snapshot mutation — those are handled by remove/restore.
  useEffect(() => {
    setCurrentCount(applyChipFilter(snapshotRef.current, chip).length);
  }, [chip]);

  // ── Optimistic mutations ─────────────────────────────────────────
  //
  // Both removeLead and restoreLead update `snapshot` AND
  // `currentCount` together. Per the invariant on `currentCount`
  // above, the optimistic update is authoritative until the next 30s
  // poll arrives. We use the functional setSnapshot form to read the
  // pre-mutation state inside the updater, capture whether the
  // operation actually changed anything, and only then apply the
  // matching ±1 to currentCount via the functional setCurrentCount.
  // Closure-variable-from-updater is a known wart in strict mode
  // (updater may run twice) but the captured value is a pure function
  // of (prev, lead) so re-execution produces the same result.

  const removeLead = useCallback(
    (lead: QueueLeadRow) => {
      let didRemoveMatchingChip = false;
      setSnapshot((prev) => {
        const idx = prev.findIndex((l) => l.id === lead.id);
        if (idx < 0) {
          didRemoveMatchingChip = false;
          return prev;
        }
        didRemoveMatchingChip = leadMatchesChip(lead, chip);
        const next = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
        snapshotRef.current = next;
        return next;
      });
      if (didRemoveMatchingChip) {
        // Codex P2: optimistic count update so the banner stays at
        // delta=0 across the mutation. Without this, after a remove
        // the snapshot's chip-filtered length drops by 1 but
        // currentCount (last poll) doesn't, so newItemsDelta swings
        // to +1 and the rep sees a false "1 new item" banner until
        // the next 30s tick. Math.max guards a paranoid underflow.
        setCurrentCount((c) => Math.max(0, c - 1));
      }
    },
    [chip],
  );

  const restoreLead = useCallback(
    (lead: QueueLeadRow) => {
      let didInsertMatchingChip = false;
      setSnapshot((prev) => {
        // Avoid duplicates if restoreLead is called twice.
        if (prev.some((l) => l.id === lead.id)) {
          didInsertMatchingChip = false;
          return prev;
        }
        didInsertMatchingChip = leadMatchesChip(lead, chip);
        // Place the lead back at its original index from the original
        // snapshot order. Falls back to append if the order is unknown.
        const order = snapshotOrderRef.current;
        const idx = order.indexOf(lead.id);
        if (idx < 0) {
          const next = [...prev, lead];
          snapshotRef.current = next;
          return next;
        }
        // Walk `prev` and find where to insert: keep the same
        // relative order as the original snapshot. Find the first
        // existing lead in `prev` whose original index is > our index.
        let insertAt = prev.length;
        for (let i = 0; i < prev.length; i += 1) {
          const existingIdx = order.indexOf(prev[i].id);
          if (existingIdx > idx) {
            insertAt = i;
            break;
          }
        }
        const next = prev.slice();
        next.splice(insertAt, 0, lead);
        snapshotRef.current = next;
        return next;
      });
      if (didInsertMatchingChip) {
        // Codex P2 companion to removeLead's decrement — keeps the
        // banner at delta=0 across an Undo round-trip.
        setCurrentCount((c) => c + 1);
      }
    },
    [chip],
  );

  // newItemsDelta is derived, not stored — so it's always coherent
  // with snapshot + currentCount.
  const visibleNow = applyChipFilter(snapshot, chip).length;
  const newItemsDelta = currentCount - visibleNow;

  return {
    snapshot,
    hiddenCount,
    currentCount,
    isLoading,
    error,
    newItemsDelta,
    refresh,
    removeLead,
    restoreLead,
  };
}
