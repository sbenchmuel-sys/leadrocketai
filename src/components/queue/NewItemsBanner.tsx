// ============================================================
// NewItemsBanner — "N new items — refresh" banner that appears
// above the queue list when the background poll (`useQueueSnapshot`)
// detects a count delta vs. the snapshot.
//
// Brief §8: the banner is driven by a separate count poll, NOT a
// React re-render of the underlying data. Clicking refresh triggers
// a full re-snapshot via the parent.
//
// Sign-aware: positive delta = "N new items", negative = "N items
// resolved" (handled or snoozed-out elsewhere). Both should prompt a
// refresh so the rep stays in sync.
// ============================================================

import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

interface NewItemsBannerProps {
  delta: number;
  onRefresh: () => void;
}

export function NewItemsBanner({ delta, onRefresh }: NewItemsBannerProps) {
  if (delta === 0) return null;
  const abs = Math.abs(delta);
  const noun = abs === 1 ? "item" : "items";
  const verb = delta > 0 ? "new" : "resolved";
  return (
    <div className="flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
      <span className="text-foreground">
        {abs} {verb} {noun}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        onClick={onRefresh}
      >
        <RefreshCw className="h-3 w-3" />
        Refresh
      </Button>
    </div>
  );
}
