import { cn } from "@/lib/utils";
import { DealStage, STAGE_LABELS, STAGE_ORDER } from "@/lib/dashboardUtils";
import { ChevronRight } from "lucide-react";

interface DealFlowBarProps {
  stageCounts: Record<DealStage, number>;
  activeStage: DealStage | null;
  onStageClick: (stage: DealStage | null) => void;
}

export function DealFlowBar({ stageCounts, activeStage, onStageClick }: DealFlowBarProps) {
  return (
    <div className="flex items-center justify-between bg-muted/50 rounded-lg p-1 overflow-x-auto">
      {STAGE_ORDER.map((stage, index) => (
        <div key={stage} className="flex items-center flex-1 min-w-0">
          <button
            onClick={() => onStageClick(activeStage === stage ? null : stage)}
            className={cn(
              "flex-1 flex flex-col items-center py-3 px-2 rounded-md transition-all text-center min-w-0",
              activeStage === stage
                ? "bg-primary text-primary-foreground shadow-sm"
                : "hover:bg-muted text-foreground"
            )}
          >
            <span className="text-2xl font-bold">{stageCounts[stage]}</span>
            <span className="text-xs font-medium truncate w-full">{STAGE_LABELS[stage]}</span>
          </button>
          {index < STAGE_ORDER.length - 1 && (
            <ChevronRight className="h-4 w-4 text-muted-foreground/50 flex-shrink-0 mx-1" />
          )}
        </div>
      ))}
    </div>
  );
}
