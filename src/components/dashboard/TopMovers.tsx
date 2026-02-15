import { useMemo } from "react";
import { Link } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import type { EnrichedLead } from "@/lib/dashboardUtils";

interface TopMoversProps {
  leads: EnrichedLead[];
}

interface Mover {
  leadId: string;
  leadName: string;
  company: string;
  reason: string;
  impactScore: number;
  time: string;
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

      let bestReason = "";
      let bestScore = 0;

      // Meeting scheduled (weight: 90)
      if (lead.hasMeeting && lead.stage === "post_meeting") {
        bestReason = "Meeting scheduled";
        bestScore = 90;
      }

      // Reply after >7 days inactivity (weight: 85)
      if (lead.last_inbound_at) {
        const inboundTime = new Date(lead.last_inbound_at).getTime();
        if (inboundTime > cutoff) {
          const lastOutbound = lead.last_outbound_at
            ? new Date(lead.last_outbound_at).getTime()
            : 0;
          const gap = inboundTime - lastOutbound;
          if (gap > SEVEN_DAYS) {
            if (85 > bestScore) {
              bestReason = "Reply after extended silence";
              bestScore = 85;
            }
          } else if (70 > bestScore) {
            bestReason = "Reply received";
            bestScore = 70;
          }
        }
      }

      // Revenue State = heating_up (weight: 80)
      if (lead.revenueState === "heating_up" && 80 > bestScore) {
        bestReason = "Heating up";
        bestScore = 80;
      }

      // Revenue State = action_required (weight: 75)
      if (lead.revenueState === "action_required" && 75 > bestScore) {
        bestReason = "Action required";
        bestScore = 75;
      }

      // Reactivated from long cycle — nurture with recent inbound (weight: 82)
      if (
        lead.revenueState === "active" &&
        (lead.motion as string) === "nurture" &&
        lead.last_inbound_at &&
        new Date(lead.last_inbound_at).getTime() > cutoff &&
        82 > bestScore
      ) {
        bestReason = "Reactivated from long cycle";
        bestScore = 82;
      }

      // Engagement velocity — fast reply latency <24h (weight: 65)
      if (
        lead.last_outbound_at &&
        lead.last_inbound_at &&
        65 > bestScore
      ) {
        const outT = new Date(lead.last_outbound_at).getTime();
        const inT = new Date(lead.last_inbound_at).getTime();
        if (inT > outT && inT - outT < 24 * 60 * 60 * 1000 && inT > cutoff) {
          bestReason = "Fast engagement velocity";
          bestScore = 65;
        }
      }

      if (bestScore > 0) {
        items.push({
          leadId: lead.id,
          leadName: lead.name,
          company: lead.company,
          reason: bestReason,
          impactScore: bestScore,
          time: formatDistanceToNow(new Date(lastActivity), {
            addSuffix: true,
          }),
        });
      }
    }

    return items.sort((a, b) => b.impactScore - a.impactScore).slice(0, 3);
  }, [leads]);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Top Movers</h3>

      {movers.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          No significant movement detected in the last 48 hours.
        </p>
      ) : (
        <div className="space-y-0.5">
          {movers.map((m, i) => (
            <Link
              key={i}
              to={`/app/leads/${m.leadId}`}
              className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-muted/40 transition-colors"
            >
              <div className="min-w-0">
                <span className="text-xs text-foreground truncate block">
                  <span className="font-medium">{m.leadName}</span>
                  <span className="text-muted-foreground"> · {m.company}</span>
                </span>
                <span className="text-[11px] text-muted-foreground/70">
                  {m.reason}
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground/60 shrink-0 tabular-nums">
                {m.time}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
