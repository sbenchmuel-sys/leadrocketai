import { cn } from "@/lib/utils";
import type { RevenueState } from "@/lib/dashboardUtils";

export type DashboardFilter = RevenueState;

interface CommandStripProps {
  counts: Record<DashboardFilter, number>;
  activeFilter: DashboardFilter;
  onFilterChange: (filter: DashboardFilter) => void;
}

const segments: { key: DashboardFilter; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "action_required", label: "Action Required" },
  { key: "heating_up", label: "Heating Up" },
  { key: "long_cycle", label: "Long Cycle" },
  { key: "nurture", label: "Nurture" },
  { key: "automation", label: "Automation" },
];

export function CommandStrip({ counts, activeFilter, onFilterChange }: CommandStripProps) {
  return (
    <div className="border-b border-border">
      <div className="flex items-center gap-5">
        {segments.map((seg) => {
          const isActive = activeFilter === seg.key;
          return (
            <button
              key={seg.key}
              onClick={() => onFilterChange(seg.key)}
              className={cn(
                "relative pb-3 text-sm font-medium transition-colors flex items-center gap-2",
                "hover:text-foreground",
                isActive ? "text-foreground" : "text-muted-foreground"
              )}
            >
              <span>{seg.label}</span>
              <span
                className={cn(
                  "tabular-nums text-xs font-semibold",
                  isActive ? "text-primary" : "text-muted-foreground/60"
                )}
              >
                {counts[seg.key]}
              </span>
              {isActive && (
                <span className="absolute bottom-0 left-0 right-0 h-px bg-primary" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
