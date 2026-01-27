import { cn } from "@/lib/utils";
import { DealStage, STAGE_LABELS, STAGE_ORDER } from "@/lib/dashboardUtils";
import { ChevronRight } from "lucide-react";

interface DealFlowBarProps {
  stageCounts: Record<DealStage, number>;
  activeStage: DealStage | null;
  onStageClick: (stage: DealStage | null) => void;
}

const stageColors: Record<DealStage, { bg: string; text: string; glow: string }> = {
  new: { 
    bg: "bg-secondary", 
    text: "text-secondary-foreground",
    glow: "shadow-secondary/30"
  },
  contacted: { 
    bg: "bg-blue-500", 
    text: "text-white",
    glow: "shadow-blue-500/30"
  },
  engaged: { 
    bg: "bg-green-500", 
    text: "text-white",
    glow: "shadow-green-500/30"
  },
  post_meeting: { 
    bg: "bg-purple-500", 
    text: "text-white",
    glow: "shadow-purple-500/30"
  },
  closing: { 
    bg: "bg-orange-500", 
    text: "text-white",
    glow: "shadow-orange-500/30"
  },
  closed_won: { 
    bg: "bg-emerald-500", 
    text: "text-white",
    glow: "shadow-emerald-500/30"
  },
  closed_lost: { 
    bg: "bg-red-500", 
    text: "text-white",
    glow: "shadow-red-500/30"
  },
};

export function DealFlowBar({ stageCounts, activeStage, onStageClick }: DealFlowBarProps) {
  const totalInPipeline = STAGE_ORDER.reduce((sum, stage) => sum + stageCounts[stage], 0);

  return (
    <div className="relative">
      {/* Background track */}
      <div className="absolute inset-0 bg-muted/30 rounded-xl" />
      
      {/* Progress indicator */}
      <div className="relative flex items-center justify-between bg-card/50 backdrop-blur-sm rounded-xl p-1.5 border border-border/50 overflow-x-auto">
        {STAGE_ORDER.map((stage, index) => {
          const isActive = activeStage === stage;
          const colors = stageColors[stage];
          const count = stageCounts[stage];
          const percentage = totalInPipeline > 0 ? Math.round((count / totalInPipeline) * 100) : 0;
          
          return (
            <div key={stage} className="flex items-center flex-1 min-w-0">
              <button
                onClick={() => onStageClick(activeStage === stage ? null : stage)}
                className={cn(
                  "flex-1 flex flex-col items-center py-3 px-3 rounded-lg transition-all duration-200 text-center min-w-0 relative group",
                  isActive
                    ? `${colors.bg} ${colors.text} shadow-lg ${colors.glow}`
                    : "hover:bg-muted/80 text-foreground"
                )}
              >
                {/* Count with animation */}
                <span 
                  className={cn(
                    "text-2xl font-bold tabular-nums animate-count-up",
                    isActive ? colors.text : "text-foreground"
                  )}
                  style={{ animationDelay: `${index * 75}ms` }}
                >
                  {count}
                </span>
                
                {/* Label */}
                <span 
                  className={cn(
                    "text-xs font-medium truncate w-full",
                    isActive ? `${colors.text} opacity-90` : "text-muted-foreground"
                  )}
                >
                  {STAGE_LABELS[stage]}
                </span>
                
                {/* Percentage bar indicator (only when not active) */}
                {!isActive && percentage > 0 && (
                  <div className="absolute bottom-1 left-3 right-3 h-0.5 bg-muted-foreground/20 rounded-full overflow-hidden">
                    <div 
                      className={cn("h-full rounded-full transition-all duration-500", colors.bg)}
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                )}
              </button>
              
              {/* Chevron separator */}
              {index < STAGE_ORDER.length - 1 && (
                <ChevronRight className="h-4 w-4 text-muted-foreground/30 flex-shrink-0 mx-0.5" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
