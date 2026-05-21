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
//   - currentCount (recount from the poll, may equal snapshot count)
//   - newItemsDelta = currentCount - snapshot.length (after chip
//                     filter); positive when fresh leads have entered
//                     since snapshot, negative when leads have been
//                     handled / snoozed out by other sessions or
//                     by background syncs. The banner shows the
//                     absolute delta but only when nonzero.
//
// Brief §8 also says: "Do not try to be clever about WHICH items are
// new — just the count delta." So this hook intentionally does not
// diff lead IDs.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchQueueLeads,
  fetchVisibleQueueLeadsCount,
  applyChipFilter,
  type QueueLeadRow,
  type QueueChipBucket,
} from "@/lib/queueQueries";

const POLL_INTERVAL_MS = 30_000;

export interface QueueSnapshot {
  /** Stable snapshot — does not reorder while the rep works the queue. */
  snapshot: QueueLeadRow[];
  /** Count of leads hidden by the intent filter (drives "N routine items hidden"). */
  hiddenCount: number;
  /** Most recent poll count for the current chip filter. */
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
   * rep clicks Undo.
   */
  removeLead: (leadId: string) => void;
  /** Restore an optimistically-removed lead in its original position. */
  restoreLead: (lead: QueueLeadRow) => void;
}

interface UseQueueSnapshotOpts {
  /** Chip filter — the count poll reflects this filter so the banner
   *  shows "N new items" relative to what the rep is actually viewing. */
  chip: QueueChipBucket | null;
}

export function useQueueSnapshot(opts: UseQueueSnapshotOpts): QueueSnapshot {
  const { chip } = opts;

  const [snapshot, setSnapshot] = useState<QueueLeadRow[]>([]);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentCount, setCurrentCount] = useState(0);

  // We track the lead order at snapshot time so optimistic restore
  // puts the card back in its rightful row (not at the end). The
  // alternative — a Map<id, row> — loses ordering.
  const snapshotOrderRef = useRef<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const { leads, hiddenCount: hc } = await fetchQueueLeads({ showAll: false });
      setSnapshot(leads);
      setHiddenCount(hc);
      snapshotOrderRef.current = leads.map((l) => l.id);
      const filtered = applyChipFilter(leads, chip);
      setCurrentCount(filtered.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      console.error("[useQueueSnapshot] refresh failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, [chip]);

  // Initial mount only — refresh is stable per-chip via useCallback.
  // We deliberately do NOT re-snapshot when `chip` changes (chip is
  // a client-side filter on the existing snapshot).
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Background poll. Lightweight count-only query. Updates
  // `currentCount`; component derives the banner from
  // `newItemsDelta` so we never mutate the snapshot here.
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
  // "currently visible count" shifts. Recompute it locally from the
  // snapshot so the banner doesn't immediately misfire while we wait
  // for the next poll.
  useEffect(() => {
    setCurrentCount(applyChipFilter(snapshot, chip).length);
  }, [chip, snapshot]);

  const removeLead = useCallback((leadId: string) => {
    setSnapshot((prev) => prev.filter((l) => l.id !== leadId));
  }, []);

  const restoreLead = useCallback((lead: QueueLeadRow) => {
    setSnapshot((prev) => {
      // Avoid duplicates if restoreLead is called twice.
      if (prev.some((l) => l.id === lead.id)) return prev;
      // Place the lead back at its original index from the original
      // snapshot order. Falls back to append if the order is unknown.
      const order = snapshotOrderRef.current;
      const idx = order.indexOf(lead.id);
      if (idx < 0) return [...prev, lead];
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
      return next;
    });
  }, []);

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
