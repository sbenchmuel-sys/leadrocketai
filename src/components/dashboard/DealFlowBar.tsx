import { cn } from "@/lib/utils";
import { DealStage, STAGE_LABELS, STAGE_ORDER } from "@/lib/dashboardUtils";
import { Progress } from "@/components/ui/progress";

interface DealFlowBarProps {
  stageCounts: Record<DealStage, number>;
  activeStage: DealStage | null;
  onStageClick: (stage: DealStage | null) => void;
}

const stageAccent: Record<DealStage, string> = {
  new: "bg-muted-foreground",
  contacted: "bg-info",
  engaged: "bg-success",
  post_meeting: "bg-purple-500",
  closing: "bg-warning",
  closed_won: "bg-emerald-500",
  closed_lost: "bg-destructive",
};

export function DealFlowBar({ stageCounts, activeStage, onStageClick }: DealFlowBarProps) {
  const total = STAGE_ORDER.reduce((sum, s) => sum + stageCounts[s], 0);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
      {STAGE_ORDER.map((stage) => {
        const count = stageCounts[stage];
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        const isActive = activeStage === stage;

        return (
          <button
            key={stage}
            onClick={() => onStageClick(isActive ? null : stage)}
            className={cn(
              "flex flex-col gap-1.5 rounded-lg px-3 py-2.5 text-left transition-all duration-200",
              "hover:bg-muted/60",
              isActive
                ? "bg-muted ring-1 ring-border shadow-sm"
                : "bg-transparent"
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground truncate">
                {STAGE_LABELS[stage]}
              </span>
              <span className="text-sm font-bold tabular-nums text-foreground">
                {count}
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-500",
                  stageAccent[stage]
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
          </button>
        );
      })}
    </div>
  );
}
