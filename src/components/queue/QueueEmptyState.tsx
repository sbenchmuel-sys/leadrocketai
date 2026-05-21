// ============================================================
// QueueEmptyState — two flavors:
//
//   1. "no_matches" — no leads pass the current chip filter.
//      Copy: "Queue clear. Nice."
//   2. "all_hidden" — there ARE candidate leads, but every one was
//      filtered by the intent hide-list. Encourages "Show all" so the
//      rep can see what got hidden (debugs trust if they think the
//      queue is broken).
// ============================================================

import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface QueueEmptyStateProps {
  variant: "no_matches" | "all_hidden";
  hiddenCount?: number;
  onShowAll?: () => void;
}

export function QueueEmptyState({ variant, hiddenCount, onShowAll }: QueueEmptyStateProps) {
  if (variant === "all_hidden" && hiddenCount && hiddenCount > 0) {
    const noun = hiddenCount === 1 ? "action item" : "action items";
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <CheckCircle2 className="h-8 w-8 text-muted-foreground/60" />
        <p className="max-w-sm text-sm text-muted-foreground">
          All {hiddenCount} {noun} today were routine (meeting accepts, OOOs, bounces).
        </p>
        {onShowAll && (
          <Button type="button" variant="link" size="sm" onClick={onShowAll} className="h-auto p-0 text-sm">
            Show all
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <CheckCircle2 className="h-8 w-8 text-muted-foreground/60" />
      <p className="text-sm text-muted-foreground">Queue clear. Nice.</p>
    </div>
  );
}
