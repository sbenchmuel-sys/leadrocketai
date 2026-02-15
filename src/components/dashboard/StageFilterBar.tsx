import { cn } from "@/lib/utils";

export type StageFilter = "all" | "new" | "contacted" | "engaged" | "post_meeting" | "nurture";

interface StageFilterBarProps {
  counts: Record<StageFilter, number>;
  activeStage: StageFilter;
  onStageChange: (stage: StageFilter) => void;
}

const stages: { key: StageFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "engaged", label: "Engaged" },
  { key: "post_meeting", label: "Post-Meeting" },
  { key: "nurture", label: "Nurture" },
];

export function StageFilterBar({ counts, activeStage, onStageChange }: StageFilterBarProps) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto">
      {stages.map((s) => {
        const isActive = activeStage === s.key;
        const count = counts[s.key];
        const isMuted = count === 0 && !isActive;

        return (
          <button
            key={s.key}
            onClick={() => onStageChange(s.key)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap",
              isActive
                ? "bg-muted text-foreground"
                : isMuted
                  ? "text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/30"
                  : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            )}
          >
            <span>{s.label}</span>
            <span
              className={cn(
                "text-xs tabular-nums",
                isActive ? "text-foreground" : "text-muted-foreground/60"
              )}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
