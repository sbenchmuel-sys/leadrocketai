import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import type { EnrichedLead } from "@/lib/dashboardUtils";

interface AIInsightPanelProps {
  leads: EnrichedLead[];
}

interface RevenueSignal {
  summary: string;
  detail: string;
  action: string;
  leadId: string;
}

export function AIInsightPanel({ leads }: AIInsightPanelProps) {
  const signal = useMemo<RevenueSignal | null>(() => {
    if (leads.length === 0) return null;

    // 1. Strong Heating Up signal (high engagement acceleration)
    const heatingUp = leads.find((l) => {
      if (l.revenueState !== "heating_up") return false;
      if (!l.last_inbound_at) return false;
      const hoursSince = (Date.now() - new Date(l.last_inbound_at).getTime()) / (1000 * 60 * 60);
      return hoursSince < 48 && (l.stage === "post_meeting" || l.stage === "closing");
    });
    if (heatingUp) {
      const signals: string[] = [];
      if (heatingUp.hasMeeting) signals.push("meeting held");
      const outlook = ((heatingUp as any).deal_outlook || "").toLowerCase();
      if (outlook.includes("pricing")) signals.push("pricing discussed");
      if (heatingUp.last_inbound_at) {
        const h = (Date.now() - new Date(heatingUp.last_inbound_at).getTime()) / (1000 * 60 * 60);
        if (h < 24) signals.push("fast replies");
      }
      return {
        summary: `${heatingUp.name} is accelerating — ${signals.join(", ") || "strong engagement"}.`,
        detail: `This conversation shows multiple buying signals. Move quickly to maintain momentum.`,
        action: "Open Deal",
        leadId: heatingUp.id,
      };
    }

    // 2. High-value Action Required conversation
    const urgentAction = leads.find((l) => {
      if (l.revenueState !== "action_required") return false;
      return l.needs_action && (l.stage === "closing" || l.stage === "post_meeting");
    });
    if (urgentAction) {
      return {
        summary: `${urgentAction.name} needs your input — ${urgentAction.next_action_label || "action pending"}.`,
        detail: `High-value conversation waiting on your response. Delay risks losing momentum.`,
        action: "Take Action",
        leadId: urgentAction.id,
      };
    }

    // 3. Long Cycle reactivation opportunity
    const reactivation = leads.find((l) => {
      if (l.revenueState !== "long_cycle") return false;
      if (!l.last_inbound_at) return false;
      const daysSince = (Date.now() - new Date(l.last_inbound_at).getTime()) / (1000 * 60 * 60 * 24);
      return daysSince < 14; // Recent sign of life in a long cycle
    });
    if (reactivation) {
      return {
        summary: `${reactivation.name} is showing renewed interest after a quiet period.`,
        detail: `Long-cycle conversation with recent activity. Consider re-engaging with a fresh angle.`,
        action: "Re-engage",
        leadId: reactivation.id,
      };
    }

    // 4. Cooling conversation risk
    const cooling = leads.find((l) => {
      if (l.stage === "closed_won" || l.stage === "closed_lost") return false;
      if (!l.last_outbound_at) return false;
      const days = (Date.now() - new Date(l.last_outbound_at).getTime()) / (1000 * 60 * 60 * 24);
      return days > 10 && days <= 21 && !l.last_inbound_at;
    });
    if (cooling) {
      return {
        summary: `${cooling.name} is cooling — no response in over 10 days.`,
        detail: `Consider switching approach or moving to nurture cadence before this goes cold.`,
        action: "Review",
        leadId: cooling.id,
      };
    }

    return null;
  }, [leads]);

  return (
    <div className="border-l-2 border-primary/30 pl-4 py-3">
      <h3 className="text-sm font-semibold text-foreground mb-2">Revenue Signal</h3>

      {signal ? (
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm text-foreground font-medium">{signal.summary}</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Recommended action: {signal.detail}
            </p>
          </div>
          <Button size="sm" variant="outline" className="shrink-0 h-8 text-xs rounded-md" asChild>
            <Link to={`/app/leads/${signal.leadId}`}>{signal.action}</Link>
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No significant revenue signals detected.
        </p>
      )}
    </div>
  );
}
