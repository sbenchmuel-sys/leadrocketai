// ============================================================
// ShowAllToggle — "N routine items hidden · show all" header.
//
// Sits at the top of the queue list. When showing intent-hide items,
// flips to "Hiding N routine items · hide". The state is deliberately
// ephemeral (brief §9 — show-all is NOT persisted across reloads).
// ============================================================

import { Button } from "@/components/ui/button";

interface ShowAllToggleProps {
  hiddenCount: number;
  showAll: boolean;
  onToggle: () => void;
}

export function ShowAllToggle({ hiddenCount, showAll, onToggle }: ShowAllToggleProps) {
  if (hiddenCount <= 0) return null;
  const noun = hiddenCount === 1 ? "routine item" : "routine items";
  return (
    <div className="flex items-center justify-between rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <span>
        {showAll
          ? `Showing ${hiddenCount} ${noun} normally hidden (meeting accepts, OOOs, bounces, …)`
          : `${hiddenCount} ${noun} hidden`}
      </span>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0 text-xs"
        onClick={onToggle}
      >
        {showAll ? "Hide" : "Show all"}
      </Button>
    </div>
  );
}
