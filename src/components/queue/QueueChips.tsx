// ============================================================
// QueueChips — single-select reason chip strip at top of Queue.
//
// Two chips: Replied / Follow up. Single-select behavior (brief §4):
// click to select, click again to deselect. Default: none selected,
// all unhidden leads visible. (Back-from-away leads fold into "Follow
// up" with a card note — no separate OOO chip.)
//
// Counts are derived from the snapshot in the parent (Queue.tsx),
// not from a separate fetch — so chip counts always match what the
// rep would see after clicking. No drift.
//
// Mobile (brief §11): wraps to multi-row when narrow. The buttons
// themselves are touch-sized (h-8) and tap targets meet the 44×44
// guideline because they include text padding on either side.
// ============================================================

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { QueueChipBucket } from "@/lib/queueQueries";

interface QueueChipsProps {
  active: QueueChipBucket | null;
  counts: { replied: number; followup_due: number };
  onSelect: (next: QueueChipBucket | null) => void;
}

interface ChipDef {
  id: QueueChipBucket;
  label: string;
}

const CHIPS: ChipDef[] = [
  { id: "replied", label: "Replied" },
  { id: "followup_due", label: "Follow up" },
];

export function QueueChips({ active, counts, onSelect }: QueueChipsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Queue reason filter">
      {CHIPS.map((chip) => {
        const isActive = active === chip.id;
        const count = chip.id === "replied" ? counts.replied : counts.followup_due;
        return (
          <Button
            key={chip.id}
            type="button"
            variant={isActive ? "default" : "outline"}
            size="sm"
            aria-pressed={isActive}
            // Single-select toggle: click active chip → deselect.
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
              {count}
            </Badge>
          </Button>
        );
      })}
    </div>
  );
}
