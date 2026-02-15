import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Crosshair } from "lucide-react";

interface AIFocusPanelProps {
  topItem: {
    leadId: string;
    leadName: string;
    stage: string;
    reason: string;
    buttonLabel: string;
  } | null;
  onAction?: () => void;
}

export function AIFocusPanel({ topItem, onAction }: AIFocusPanelProps) {
  return (
    <div className="border-t border-border pt-5">
      <div className="flex items-center gap-2 mb-3">
        <Crosshair className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">AI Focus</h3>
      </div>

      {topItem ? (
        <div className="flex items-center justify-between gap-4">
          <Link to={`/app/leads/${topItem.leadId}`} className="min-w-0 flex-1 hover:underline">
            <p className="text-sm font-medium text-foreground">{topItem.leadName}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {topItem.stage} · {topItem.reason}
            </p>
          </Link>
          <Button size="sm" className="shrink-0 h-8 text-xs" onClick={onAction}>
            {topItem.buttonLabel}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No actions pending. Assistant monitoring engagement patterns.
        </p>
      )}
    </div>
  );
}
