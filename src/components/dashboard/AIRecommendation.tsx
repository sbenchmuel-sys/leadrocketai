import { Sparkles, TrendingDown, Leaf, AlertTriangle, Flame } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EnrichedLead } from "@/lib/dashboardUtils";

interface AIInsightsPanelProps {
  warmingUpLeads: EnrichedLead[];
  coolingDownCount: number;
  nurtureCandidates: number;
  atRisk: number;
}

function getTopWarmingCandidate(leads: EnrichedLead[]): string | null {
  if (leads.length === 0) return null;
  const lead = leads[0];
  const signals: string[] = [];

  // Check progress signals
  const outlook = ((lead as any).deal_outlook || "").toLowerCase();
  if (outlook.includes("pricing") || lead.stage === "closing") signals.push("pricing mentioned");
  if (lead.hasMeeting || lead.stage === "post_meeting") signals.push("meeting held");

  // Check engagement signals
  if (lead.last_inbound_at) {
    const hoursSince = (Date.now() - new Date(lead.last_inbound_at).getTime()) / (1000 * 60 * 60);
    if (hoursSince < 24) signals.push("fast replies");
    else if (hoursSince < 72) signals.push("recent reply");
  }

  const signalText = signals.length > 0 ? ` — ${signals.join(", ")}` : "";
  return `Focus on ${lead.name}${signalText}.`;
}

export function AIRecommendation({
  warmingUpLeads,
  coolingDownCount,
  nurtureCandidates,
  atRisk,
}: AIInsightsPanelProps) {
  const warmingUp = warmingUpLeads.length;
  const topCandidate = getTopWarmingCandidate(warmingUpLeads);

  const rows = [
    {
      label: `${coolingDownCount} lead${coolingDownCount !== 1 ? "s" : ""} cooling down`,
      icon: TrendingDown,
      color: "text-muted-foreground",
      show: true,
    },
    {
      label: `${nurtureCandidates} nurture candidate${nurtureCandidates !== 1 ? "s" : ""}`,
      icon: Leaf,
      color: "text-info",
      show: true,
    },
    {
      label: `${atRisk} urgent risk${atRisk !== 1 ? "s" : ""}`,
      icon: AlertTriangle,
      color: atRisk > 0 ? "text-warning" : "text-muted-foreground",
      show: true,
    },
  ];

  return (
    <div className="rounded-lg border border-primary/20 bg-gradient-to-br from-primary/5 to-transparent p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Deal Intelligence</h3>
      </div>

      {/* Primary line */}
      <div className="flex items-center gap-2 px-1">
        <Flame className="h-4 w-4 text-orange-500 shrink-0" />
        <p className="text-sm font-medium text-foreground">
          {warmingUp} lead{warmingUp !== 1 ? "s" : ""} warming up this week.
        </p>
      </div>

      {/* Secondary lines */}
      <div className="space-y-1">
        {rows.map((row) =>
          row.show ? (
            <div
              key={row.label}
              className="flex items-center gap-2 px-2.5 py-1 rounded-md bg-background/60"
            >
              <row.icon className={cn("h-3 w-3 shrink-0", row.color)} />
              <span className="text-xs text-muted-foreground">{row.label}</span>
            </div>
          ) : null
        )}
      </div>

      {/* Top candidate recommendation */}
      {topCandidate && warmingUp > 0 && (
        <div className="flex items-start gap-2 rounded-md bg-orange-500/5 border border-orange-500/20 px-2.5 py-2">
          <Sparkles className="h-3.5 w-3.5 text-orange-500 shrink-0 mt-0.5" />
          <p className="text-xs text-foreground leading-relaxed">
            {topCandidate}
          </p>
        </div>
      )}

      {warmingUp === 0 && (
        <p className="text-xs text-muted-foreground text-center py-1">
          No leads warming up right now.
        </p>
      )}
    </div>
  );
}
