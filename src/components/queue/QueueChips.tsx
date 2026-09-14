// ============================================================
// QueueChips — visible tab toggle at the top of the Queue (Unit E).
//
// Three tabs: Replied / Follow up / Outreach. Single-select: click to
// select, click again to deselect (deselected = the full reactive list).
//   • Replied + Follow up are the REACTIVE lists (the default view).
//     "Follow up" now also absorbs out-of-office leads when they're next
//     due (the dedicated "OOO" tab was removed — UI grouping only; the
//     OOO detection + send-pause logic is unchanged).
//   • Outreach is the cold-campaign touch list, kept separate so cold
//     volume never floods the reactive lists.
//
// Visible on every screen size (wraps to multi-row when narrow); never
// swipe-only. Counts come from the parent snapshot so they never drift.
// ============================================================

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type QueueTab = "replied" | "followup" | "outreach";

interface QueueChipsProps {
  active: QueueTab | null;
  /** null for a count = unknown (a read failed). Rendered "—", never 0. */
  counts: { replied: number; followup: number; outreach: number | null };
  onSelect: (next: QueueTab | null) => void;
}

/** "All" is the no-tab-selected state, which until now had no name on screen —
 *  the rep could land in it and have no way back to it except by clicking the
 *  selected tab again. It is a chip like the others, and it is the default. */
const CHIPS: { id: QueueTab | null; label: string }[] = [
  { id: null, label: "All" },
  { id: "replied", label: "Replied" },
  { id: "followup", label: "Follow up" },
  { id: "outreach", label: "Outreach" },
];

export function QueueChips({ active, counts, onSelect }: QueueChipsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Queue list tabs">
      {CHIPS.map((chip) => {
        const isActive = active === chip.id;
        // "All" = the two reactive lists. Outreach is a separate source with its
        // own tab, so it is deliberately not added in here.
        const count = chip.id === null ? counts.replied + counts.followup : counts[chip.id];
        return (
          <Button
            key={chip.id ?? "all"}
            type="button"
            variant={isActive ? "default" : "outline"}
            size="sm"
            aria-pressed={isActive}
            onClick={() => onSelect(isActive ? null : chip.id)}
            className={cn(
              "h-8 rounded-full px-3 text-xs font-medium",
              isActive ? "" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span>{chip.label}</span>
            <Badge
              variant="secondary"
              className={cn(
                "ml-1.5 px-1.5 py-0 text-[10px] tabular-nums",
                isActive ? "bg-primary-foreground/20 text-primary-foreground" : "",
              )}
            >
              {count ?? "—"}
            </Badge>
          </Button>
        );
      })}
    </div>
  );
}
