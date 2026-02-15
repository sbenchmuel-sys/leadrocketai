import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";
import type { EnrichedLead } from "@/lib/dashboardUtils";

interface AIInsightPanelProps {
  leads: EnrichedLead[];
}

interface Insight {
  message: string;
  detail: string;
  leadId: string;
}

export function AIInsightPanel({ leads }: AIInsightPanelProps) {
  const insight = useMemo<Insight | null>(() => {
    if (leads.length === 0) return null;

    // 1. High-intent lead (recent inbound + advanced stage)
    const highIntent = leads.find((l) => {
      if (!l.last_inbound_at) return false;
      const hoursSince = (Date.now() - new Date(l.last_inbound_at).getTime()) / (1000 * 60 * 60);
      return hoursSince < 48 && (l.stage === "post_meeting" || l.stage === "closing");
    });
    if (highIntent) {
      const signals: string[] = [];
      if (highIntent.hasMeeting) signals.push("Meeting held");
      if (highIntent.last_inbound_at) {
        const h = (Date.now() - new Date(highIntent.last_inbound_at).getTime()) / (1000 * 60 * 60);
        if (h < 24) signals.push("Fast replies");
      }
      const outlook = ((highIntent as any).deal_outlook || "").toLowerCase();
      if (outlook.includes("pricing")) signals.push("Pricing discussed");
      return {
        message: `${highIntent.name} shows strong buying signals.`,
        detail: signals.join(". ") + ".",
        leadId: highIntent.id,
      };
    }

    // 2. At risk lead (stale + not closed)
    const atRisk = leads.find((l) => {
      if (l.stage === "closed_won" || l.stage === "closed_lost") return false;
      if (!l.last_outbound_at) return false;
      const days = (Date.now() - new Date(l.last_outbound_at).getTime()) / (1000 * 60 * 60 * 24);
      return days > 14;
    });
    if (atRisk) {
      return {
        message: `${atRisk.name} is going cold.`,
        detail: `No outbound contact in over 14 days. Consider re-engaging.`,
        leadId: atRisk.id,
      };
    }

    // 3. Ready to move stage
    const readyToMove = leads.find((l) => {
      if (l.stage !== "engaged" && l.stage !== "contacted") return false;
      if (!l.last_inbound_at) return false;
      const h = (Date.now() - new Date(l.last_inbound_at).getTime()) / (1000 * 60 * 60);
      return h < 72 && l.hasMeeting;
    });
    if (readyToMove) {
      return {
        message: `${readyToMove.name} may be ready to advance.`,
        detail: `Recent engagement with meeting activity detected.`,
        leadId: readyToMove.id,
      };
    }

    // 4. Nurture opportunity
    const nurtureOpp = leads.find((l) => {
      return (l.motion === "outbound_prospecting" || l.motion === "inbound_response") &&
        !l.last_inbound_at && l.first_outbound_at &&
        (Date.now() - new Date(l.first_outbound_at).getTime()) / (1000 * 60 * 60 * 24) > 10;
    });
    if (nurtureOpp) {
      return {
        message: `${nurtureOpp.name} could benefit from nurture mode.`,
        detail: `No response after multiple follow-ups. Consider switching to nurture cadence.`,
        leadId: nurtureOpp.id,
      };
    }

    return null;
  }, [leads]);

  return (
    <div className="border-t border-border pt-5">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">AI Insight</h3>
      </div>

      {insight ? (
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-foreground font-medium">{insight.message}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{insight.detail}</p>
          </div>
          <Button size="sm" variant="outline" className="shrink-0 h-8 text-xs" asChild>
            <Link to={`/app/leads/${insight.leadId}`}>Open Deal</Link>
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No strong signals detected. Assistant monitoring engagement patterns.
        </p>
      )}
    </div>
  );
}
