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
      const lastActivity = lead.last_activity_at
        ? new Date(lead.last_activity_at).getTime()
        : 0;
      if (lastActivity < cutoff) continue;

      const signals: string[] = [];
      let bestScore = 0;
      let hasUpArrow = false;

      // Meeting scheduled (90)
      if (lead.hasMeeting && lead.stage === "post_meeting") {
        signals.push("Meeting scheduled");
        bestScore = Math.max(bestScore, 90);
      }

      // Reply after >7d inactivity (85) or normal reply (70)
      if (lead.last_inbound_at) {
        const inT = new Date(lead.last_inbound_at).getTime();
        if (inT > cutoff) {
          const lastOut = lead.last_outbound_at
            ? new Date(lead.last_outbound_at).getTime()
            : 0;
          const gap = inT - lastOut;
          if (gap > SEVEN_DAYS) {
            const days = Math.round(gap / (1000 * 60 * 60 * 24));
            signals.push(`Reactivated after ${days} days`);
            bestScore = Math.max(bestScore, 85);
          } else {
            signals.push("Reply received");
            bestScore = Math.max(bestScore, 70);
          }
        }
      }

      // Reactivated from nurture (82)
      if (
        lead.revenueState === "active" &&
        (lead.motion as string) === "nurture" &&
        lead.last_inbound_at &&
        new Date(lead.last_inbound_at).getTime() > cutoff &&
        !signals.some((s) => s.startsWith("Reactivated"))
      ) {
        signals.push("Reactivated from long cycle");
        bestScore = Math.max(bestScore, 82);
      }

      // Heating up (80)
      if (lead.revenueState === "heating_up") {
        signals.push("Moved to Heating Up");
        bestScore = Math.max(bestScore, 80);
        hasUpArrow = true;
      }

      // Action required (75)
      if (lead.revenueState === "action_required") {
        signals.push("Action required");
        bestScore = Math.max(bestScore, 75);
      }

      // Fast engagement velocity (65)
      if (lead.last_outbound_at && lead.last_inbound_at) {
        const outT = new Date(lead.last_outbound_at).getTime();
        const inT = new Date(lead.last_inbound_at).getTime();
        if (inT > outT && inT - outT < 24 * 60 * 60 * 1000 && inT > cutoff) {
          signals.push("Engagement velocity ↑");
          bestScore = Math.max(bestScore, 65);
          hasUpArrow = true;
        }
      }

      if (bestScore > 0 && signals.length > 0) {
        items.push({
          leadId: lead.id,
          leadName: lead.name,
          summary: signals.slice(0, 2).join(" · "),
          impactScore: bestScore,
          time: formatDistanceToNow(new Date(lastActivity), { addSuffix: true }),
          hasUpArrow,
        });
      }
    }

    return items.sort((a, b) => b.impactScore - a.impactScore).slice(0, 3);
  }, [leads]);

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">Top Movers</h3>

      {movers.length === 0 ? (
        <p className="text-xs text-muted-foreground py-3 text-center">
          No significant movement detected in the last 48 hours.
        </p>
      ) : (
        <div className="divide-y divide-border/40">
          {movers.map((m, i) => (
            <Link
              key={i}
              to={`/app/leads/${m.leadId}`}
              className="flex items-center justify-between gap-3 py-2.5 px-1.5 hover:bg-muted/30 transition-colors rounded-sm group"
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