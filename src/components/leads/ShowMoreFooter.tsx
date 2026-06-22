// Shared "showing N of M · Show next / Show all" footer for the Leads page
// lists (All-leads table and To-do list). Renders nothing once everything is
// already shown.

import { Button } from "@/components/ui/button";

interface ShowMoreFooterProps {
  /** How many rows are currently visible. */
  shown: number;
  /** Total rows available in the (filtered) list. */
  total: number;
  /** Group size revealed per "Show next" click. */
  pageSize?: number;
  onShowMore: () => void;
  onShowAll: () => void;
}

export function ShowMoreFooter({
  shown,
  total,
  pageSize = 25,
  onShowMore,
  onShowAll,
}: ShowMoreFooterProps) {
  if (total <= shown) return null;
  const nextChunk = Math.min(pageSize, total - shown);
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border px-4 py-3 text-xs text-muted-foreground">
      <span>
        Showing {shown} of {total}
      </span>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={onShowMore}>
          Show next {nextChunk}
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={onShowAll}>
          Show all
        </Button>
      </div>
    </div>
  );
}
