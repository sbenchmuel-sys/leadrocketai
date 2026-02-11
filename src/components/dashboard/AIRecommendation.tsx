import { Sparkles, TrendingUp, ShieldAlert, Leaf, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EnrichedLead } from "@/lib/dashboardUtils";

interface AIInsightsPanelProps {
  warmingUp: number;
  atRisk: number;
  nurtureCandidates: number;
  topRecommendation: string | null;
}

export function AIRecommendation({
  warmingUp,
  atRisk,
  nurtureCandidates,
  topRecommendation,
}: AIInsightsPanelProps) {
  const rows = [
    {
      label: "Warming up",
      value: warmingUp,
      icon: TrendingUp,
      color: "text-success",
      bg: "bg-success/10",
    },
    {
      label: "At risk",
      value: atRisk,
      icon: ShieldAlert,
      color: "text-destructive",
      bg: "bg-destructive/10",
    },
    {
      label: "Nurture ready",
      value: nurtureCandidates,
      icon: Leaf,
      color: "text-info",
      bg: "bg-info/10",
    },
  ];

  return (
    <div className="rounded-lg border border-primary/20 bg-gradient-to-br from-primary/5 to-transparent p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">AI Insights</h3>
      </div>

      {/* Metric rows */}
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between rounded-md px-2.5 py-1.5 bg-background/60"
          >
            <div className="flex items-center gap-2">
              <div className={cn("p-1 rounded", row.bg)}>
                <row.icon className={cn("h-3 w-3", row.color)} />
              </div>
              <span className="text-xs text-muted-foreground">{row.label}</span>
            </div>
            <span className="text-sm font-bold tabular-nums text-foreground">
              {row.value}
            </span>
          </div>
        ))}
      </div>

      {/* Top recommendation */}
      {topRecommendation && (
        <div className="flex items-start gap-2 rounded-md bg-warning/5 border border-warning/20 px-2.5 py-2">
          <Zap className="h-3.5 w-3.5 text-warning shrink-0 mt-0.5" />
          <p className="text-xs text-foreground leading-relaxed">
            {topRecommendation}
          </p>
        </div>
      )}

      {!topRecommendation && (
        <p className="text-xs text-muted-foreground text-center py-1">
          No urgent actions right now.
        </p>
      )}
    </div>
  );
}
