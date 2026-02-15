import { cn } from "@/lib/utils";

export type DashboardFilter = "active" | "need_you" | "heating_up" | "at_risk";

interface CommandStripProps {
  counts: Record<DashboardFilter, number>;
  activeFilter: DashboardFilter;
  onFilterChange: (filter: DashboardFilter) => void;
}

const segments: { key: DashboardFilter; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "need_you", label: "Need You" },
  { key: "heating_up", label: "Heating Up" },
  { key: "at_risk", label: "At Risk" },
];

export function CommandStrip({ counts, activeFilter, onFilterChange }: CommandStripProps) {
  return (
    <div className="border-b border-border">
      <div className="flex items-stretch">
        {segments.map((seg, i) => {
          const isActive = activeFilter === seg.key;
          return (
            <button
              key={seg.key}
              onClick={() => onFilterChange(seg.key)}
              className={cn(
                "flex-1 relative flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors",
                "hover:bg-muted/40",
                i > 0 && "border-l border-border",
                isActive
                  ? "text-foreground"
                  : "text-muted-foreground"
              )}
            >
              <span>{seg.label}</span>
              <span
                className={cn(
                  "tabular-nums text-xs font-semibold px-1.5 py-0.5 rounded-md",
                  isActive
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {counts[seg.key]}
              </span>
              {isActive && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
