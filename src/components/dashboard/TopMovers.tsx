import { useMemo } from "react";
import { Link } from "react-router-dom";
import { formatDistanceToNow, differenceInDays } from "date-fns";
import type { EnrichedLead } from "@/lib/dashboardUtils";

interface TopMoversProps {
  leads: EnrichedLead[];
}

interface Mover {
  leadId: string;
  leadName: string;
  summary: string;
  impactScore: number;
  time: string;
  hasUpArrow: boolean;
}

const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

export function TopMovers({ leads }: TopMoversProps) {
  const movers = useMemo(() => {
    const now = Date.now();
    const cutoff = now - FORTY_EIGHT_HOURS;
    const items: Mover[] = [];

    for (const lead of leads) {
      // Eligibility: lead-side signal in the last 48h.
      // We do NOT use last_activity_at because user-initiated outbound updates it,
      // which would surface leads that haven't actually moved.
      const inboundTs = lead.last_inbound_at
        ? new Date(lead.last_inbound_at).getTime()
        : 0;
      const meetingTs = lead.hasMeeting && lead.stage === "post_meeting" && lead.last_activity_at
        ? new Date(lead.last_activity_at).getTime()
        : 0;
      const recentInbound = inboundTs > cutoff;
      const recentMeeting = meetingTs > cutoff;
      if (!recentInbound && !recentMeeting) continue;

      const signals: string[] = [];
      let bestScore = 0;
      let hasUpArrow = false;
      let signalTs = Math.max(inboundTs, meetingTs);

      // Meeting scheduled (90)
      if (recentMeeting) {
        signals.push("Meeting scheduled");
        bestScore = Math.max(bestScore, 90);
      }

      // Reply-driven signals require a true inbound after our last outbound.
      if (recentInbound) {
        const lastOut = lead.last_outbound_at
          ? new Date(lead.last_outbound_at).getTime()
          : 0;
        if (inboundTs > lastOut) {
          const gap = inboundTs - lastOut;
          if (lastOut > 0 && gap > SEVEN_DAYS) {
            const days = Math.round(gap / (1000 * 60 * 60 * 24));
            signals.push(`Reactivated after ${days} days`);
            bestScore = Math.max(bestScore, 85);
          } else {
            signals.push("Reply received");
            bestScore = Math.max(bestScore, 70);
          }

          // Reactivated from nurture (82)
          if (
            lead.revenueState === "active" &&
            (lead.motion as string) === "nurture" &&
            !signals.some((s) => s.startsWith("Reactivated"))
          ) {
            signals.push("Reactivated from long cycle");
            bestScore = Math.max(bestScore, 82);
          }

          // Fast engagement velocity (65)
          if (lastOut > 0 && inboundTs - lastOut < 24 * 60 * 60 * 1000) {
            signals.push("Engagement velocity ↑");
            bestScore = Math.max(bestScore, 65);
            hasUpArrow = true;
          }
        }
      }

      // Heating up (80) — only credible when paired with a real lead-side signal,
      // which the eligibility gate above already enforces.
      if (lead.revenueState === "heating_up") {
        signals.push("Moved to Heating Up");
        bestScore = Math.max(bestScore, 80);
        hasUpArrow = true;
      }

      // NOTE: action_required is intentionally NOT scored here. It mirrored the
      // Action Required panel and made the two surfaces redundant.

      if (bestScore > 0 && signals.length > 0) {
        items.push({
          leadId: lead.id,
          leadName: lead.name,
          summary: signals.slice(0, 2).join(" · "),
          impactScore: bestScore,
          time: formatDistanceToNow(new Date(signalTs || now), { addSuffix: true }),
          hasUpArrow,
        });
      }
    }

    return items.sort((a, b) => b.impactScore - a.impactScore).slice(0, 3);
  }, [leads]);


  return (
    <div className="space-y-2 overflow-hidden">
      <h3 className="text-sm font-semibold text-foreground">Top Movers</h3>

      {movers.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2 text-center">
          No significant movement detected in the last 48 hours.
        </p>
      ) : (
        <div className="divide-y divide-border/40">
          {movers.map((m, i) => (
            <Link
              key={i}
              to={`/app/leads/${m.leadId}`}
              className="flex items-center justify-between gap-3 py-2 px-1.5 hover:bg-muted/30 transition-colors rounded-sm"
            >
              <div className="min-w-0 space-y-0.5">
                <span className="text-[13px] font-medium text-foreground block truncate">
                  {m.leadName}
                </span>
                <span className="text-[11px] text-muted-foreground leading-tight block truncate">
                  {m.hasUpArrow && (
                    <span className="text-primary mr-1">↑</span>
                  )}
                  {m.summary}
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground/50 shrink-0 tabular-nums">
                {m.time}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}