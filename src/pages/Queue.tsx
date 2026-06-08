// ============================================================
// /app/queue — the Queue page (Phase 2a launch, PR D).
//
// Composition:
//   - useQueueSnapshot          → stable list + 30s count poll
//   - QueueChips                → Replied / Follow up
//   - ShowAllToggle             → "N routine items hidden · show all"
//   - NewItemsBanner            → "N new items — refresh"
//   - QueueCard[] paginated     → 25/page (reuses LeadTable pattern)
//   - QueueEmptyState           → "Queue clear. Nice." / "all routine"
//
// State model:
//   • snapshot lives in `useQueueSnapshot` (stable; brief §8).
//   • chip + page index persist via `queueStateCache` (brief §9).
//   • showAll toggle is ephemeral local state — resets on reload.
//
// Mutations: optimistic. We remove the card immediately and show a
// 5s/7s undo toast (sonner). If the RPC fails, the card is restored
// and an error toast is surfaced. After undo expires, the inbound-
// only re-arm rule (PR B) handles re-surfacing.
//
// Trust contract (brief preamble): every count is defensible — the
// snapshot count matches what the rep sees, the hidden count matches
// what "show all" reveals, the chip counts match what each chip
// would show after click. Single source of truth is the snapshot.
// ============================================================

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  getQueueState,
  setQueueChip,
  setQueuePageIndex,
} from "@/lib/queueStateCache";
import {
  applyChipFilter,
  countChipBuckets,
  fetchLatestInbounds,
  type QueueChipBucket,
  type QueueLatestInbound,
  type QueueLeadRow,
} from "@/lib/queueQueries";
import {
  dismissLeadAction,
  markActionHandled,
  undoMarkActionHandled,
  type LeadActionSnapshotFull,
} from "@/lib/supabaseQueries";
import { useQueueSnapshot } from "@/hooks/useQueueSnapshot";
import { QueueChips } from "@/components/queue/QueueChips";
import { ShowAllToggle } from "@/components/queue/ShowAllToggle";
import { NewItemsBanner } from "@/components/queue/NewItemsBanner";
import { QueueEmptyState } from "@/components/queue/QueueEmptyState";
import { QueueCard } from "@/components/queue/QueueCard";
import { Button } from "@/components/ui/button";

const PAGE_SIZE = 25; // mirrors LeadTable.tsx — brief §5 ("reuse pagination")
const MOBILE_BREAKPOINT_PX = 640;
const UNDO_DURATION_MS_DESKTOP = 5_000;
const UNDO_DURATION_MS_MOBILE = 7_000;

export default function Queue() {
  // ── Persistent cache (chip + page) ─────────────────────────────
  const initial = getQueueState();
  const [chip, setChipLocal] = useState<QueueChipBucket | null>(initial.chip);
  const [pageIndex, setPageIndexLocal] = useState<number>(initial.pageIndex);

  // Ephemeral — show-all does NOT persist (brief §9).
  const [showAll, setShowAll] = useState(false);

  const {
    snapshot,
    hiddenCount,
    isLoading,
    error,
    newItemsDelta,
    refresh,
    removeLead,
    restoreLead,
  } = useQueueSnapshot({ chip, showAll });

  // Latest inbound rows for VISIBLE leads only — see brief §6.
  // Fetched after snapshot resolves; chip-filter pageful = ≤25 leads.
  const [latestInbounds, setLatestInbounds] = useState<Map<string, QueueLatestInbound>>(new Map());

  // ── Derived list ───────────────────────────────────────────────
  // The snapshot itself never reorders (brief §8). The view layer is
  // a pure function of (snapshot, chip, page) — chip filtering and
  // pagination are pure transformations applied per render.
  const chipFiltered = useMemo(() => applyChipFilter(snapshot, chip), [snapshot, chip]);

  const totalCount = chipFiltered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const safePage = Math.min(pageIndex, totalPages - 1);
  const pageLeads = useMemo(
    () => chipFiltered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [chipFiltered, safePage],
  );

  // Chip counts always come off the snapshot (post-intent-hide), so
  // toggling chips never lies about availability.
  const chipCounts = useMemo(() => countChipBuckets(snapshot), [snapshot]);

  // ── Persist chip / page changes ────────────────────────────────
  useEffect(() => {
    setQueueChip(chip);
  }, [chip]);
  useEffect(() => {
    setQueuePageIndex(pageIndex);
  }, [pageIndex]);

  // Reset page index when chip changes or showAll flips — same logic
  // as LeadTable.tsx:311 keeps "page 4 of an empty result" from
  // happening.
  useEffect(() => {
    setPageIndexLocal(0);
  }, [chip, showAll]);

  // ── Fetch latest inbound rows for the visible page only ────────
  useEffect(() => {
    let cancelled = false;
    if (pageLeads.length === 0) {
      setLatestInbounds(new Map());
      return;
    }
    const ids = pageLeads.map((l) => l.id);
    void fetchLatestInbounds(ids).then((map) => {
      if (!cancelled) setLatestInbounds(map);
    });
    return () => {
      cancelled = true;
    };
  }, [pageLeads]);

  // ── Action handlers (optimistic) ───────────────────────────────

  const undoDuration = () =>
    window.innerWidth <= MOBILE_BREAKPOINT_PX
      ? UNDO_DURATION_MS_MOBILE
      : UNDO_DURATION_MS_DESKTOP;

  const handleMarkHandled = async (lead: QueueLeadRow) => {
    // Optimistic: remove from snapshot first. Pass the full row so
    // the hook can also adjust `currentCount` to match — keeps the
    // "N new items" banner at delta=0 across the mutation (Codex P2).
    removeLead(lead);
    let snap: LeadActionSnapshotFull | null = null;
    try {
      snap = await markActionHandled(lead.id, { permanent: true });
    } catch (err) {
      // RPC failed — restore card silently (brief §7: surface error,
      // restore card "without requiring undo").
      restoreLead(lead);
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Couldn't mark as handled: ${msg}`);
      return;
    }

    toast.success("Marked as handled", {
      duration: undoDuration(),
      action: {
        label: "Undo",
        onClick: async () => {
          if (!snap) return;
          try {
            await undoMarkActionHandled(lead.id, snap);
            restoreLead(lead);
            toast.success("Restored");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            toast.error(`Undo failed: ${msg}`);
          }
        },
      },
    });
  };

  const handleSnooze = async (lead: QueueLeadRow, days: 3 | 5 | 7) => {
    // Optimistic remove. The snooze path keeps using `dismissLeadAction`
    // because mark_action_handled only supports `action_dismissed_at =
    // now()` and a forward-dated interval is the whole point of snooze.
    // See PR description "Migration disposition" table — this is the
    // one dismissLeadAction caller deliberately preserved.
    removeLead(lead);
    try {
      await dismissLeadAction(lead.id, days);
    } catch (err) {
      restoreLead(lead);
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Couldn't snooze: ${msg}`);
      return;
    }

    toast.success(`Snoozed for ${days} days`, {
      duration: undoDuration(),
      action: {
        label: "Undo",
        onClick: async () => {
          try {
            // Restore by clearing action_dismissed_at — this matches
            // the syncEngine's fresh-inbound re-arm path. We use
            // undoMarkActionHandled because it atomically writes back
            // the snapshot we kept in `lead`; the snapshot includes
            // the original `needs_action`, `next_action_key`, etc.
            await undoMarkActionHandled(lead.id, {
              needs_action: lead.needs_action,
              next_action_key: lead.next_action_key,
              next_action_label: lead.next_action_label,
              action_reason_code: lead.action_reason_code,
              action_dismissed_at: null,
              action_permanently_dismissed: false,
            });
            restoreLead(lead);
            toast.success("Snooze undone");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            toast.error(`Undo failed: ${msg}`);
          }
        },
      },
    });
  };

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Queue</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {snapshot.length === 0
              ? "Nothing waiting on you."
              : `${snapshot.length} ${snapshot.length === 1 ? "lead" : "leads"} waiting on you`}
          </p>
        </div>
      </div>

      {/* Chip strip */}
      <QueueChips active={chip} counts={chipCounts} onSelect={setChipLocal} />

      {/* Show-all toggle (intent-hidden header) */}
      <ShowAllToggle hiddenCount={hiddenCount} showAll={showAll} onToggle={() => setShowAll((s) => !s)} />

      {/* New items banner */}
      <NewItemsBanner delta={newItemsDelta} onRefresh={() => void refresh()} />

      {/* Error surface — non-fatal; the page still renders the stale snapshot */}
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          Couldn't refresh queue: {error}
        </div>
      )}

      {/* List */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-lg border border-border bg-card/40" />
          ))}
        </div>
      ) : pageLeads.length === 0 ? (
        // Two empty-state flavors. If everything was hidden by intent
        // AND the rep hasn't toggled show-all yet, point them at the
        // "Show all" affordance.
        snapshot.length === 0 && hiddenCount > 0 && !showAll ? (
          <QueueEmptyState
            variant="all_hidden"
            hiddenCount={hiddenCount}
            onShowAll={() => setShowAll(true)}
          />
        ) : (
          <QueueEmptyState variant="no_matches" />
        )
      ) : (
        <div className="space-y-2">
          {pageLeads.map((lead) => (
            <QueueCard
              key={lead.id}
              lead={lead}
              latestInbound={latestInbounds.get(lead.id)}
              onMarkHandled={handleMarkHandled}
              onSnooze={handleSnooze}
            />
          ))}
        </div>
      )}

      {/* Pagination footer — mirrors LeadTable.tsx:1212–1268 */}
      {totalCount > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-4 border-t border-border/60 px-1 py-2 text-xs text-muted-foreground">
          <span>
            {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, totalCount)} of {totalCount}
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={safePage === 0}
              onClick={() => setPageIndexLocal((i) => Math.max(0, i - 1))}
            >
              Prev
            </Button>
            <span className="px-1 tabular-nums">
              {safePage + 1} / {totalPages}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={safePage >= totalPages - 1}
              onClick={() => setPageIndexLocal((i) => Math.min(totalPages - 1, i + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
