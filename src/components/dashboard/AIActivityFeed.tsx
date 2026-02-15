import { useMemo } from "react";
import { Link } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import type { EnrichedLead } from "@/lib/dashboardUtils";

interface AIActivityFeedProps {
  leads: EnrichedLead[];
}

interface ActivityItem {
  label: string;
  leadName: string;
  leadId: string;
  time: string;
  sortTime: number;
}

export function AIActivityFeed({ leads }: AIActivityFeedProps) {
  const activities = useMemo(() => {
    const items: ActivityItem[] = [];

    // Reply received
    leads
      .filter((l) => l.last_inbound_at)
      .forEach((l) => {
        items.push({
          label: "Reply received",
          leadName: l.name,
          leadId: l.id,
          time: formatDistanceToNow(new Date(l.last_inbound_at!), { addSuffix: true }),
          sortTime: new Date(l.last_inbound_at!).getTime(),
        });
      });

    // Draft created / action pending
    leads
      .filter((l) => l.needs_action && l.next_action_label)
      .forEach((l) => {
        items.push({
          label: "Draft created",
          leadName: l.name,
          leadId: l.id,
          time: formatDistanceToNow(new Date(l.last_activity_at), { addSuffix: true }),
          sortTime: new Date(l.last_activity_at).getTime(),
        });
      });

    // Follow-up scheduled (nurture auto)
    leads
      .filter((l) => l.nurture_mode === "auto" && l.nurture_status === "active")
      .forEach((l) => {
        items.push({
          label: "Follow-up scheduled automatically",
          leadName: l.name,
          leadId: l.id,
          time: "Queued",
          sortTime: 0,
        });
      });

    // Engagement increased (stage moved recently)
    leads
      .filter((l) => l.stage !== "new" && l.stage !== "contacted")
      .forEach((l) => {
        const lastAct = new Date(l.last_activity_at).getTime();
        const hoursSince = (Date.now() - lastAct) / (1000 * 60 * 60);
        if (hoursSince < 48) {
          items.push({
            label: "Engagement increased",
            leadName: l.name,
            leadId: l.id,
            time: formatDistanceToNow(new Date(l.last_activity_at), { addSuffix: true }),
            sortTime: lastAct,
          });
        }
      });

    // Meeting scheduled
    leads
      .filter((l) => l.hasMeeting && l.stage === "post_meeting")
      .forEach((l) => {
        items.push({
          label: "Meeting scheduled",
          leadName: l.name,
          leadId: l.id,
          time: formatDistanceToNow(new Date(l.last_activity_at), { addSuffix: true }),
          sortTime: new Date(l.last_activity_at).getTime(),
        });
      });

    return items.sort((a, b) => b.sortTime - a.sortTime).slice(0, 10);
  }, [leads]);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">AI Activity</h3>

      {activities.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          No recent activity.
        </p>
      ) : (
        <div className="space-y-0.5 max-h-[320px] overflow-y-auto">
          {activities.map((a, i) => (
            <Link
              key={i}
              to={`/app/leads/${a.leadId}`}
              className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-muted/40 transition-colors"
            >
              <span className="text-xs text-foreground truncate min-w-0">
                {a.label} — <span className="font-medium">{a.leadName}</span>
              </span>
              <span className="text-[10px] text-muted-foreground/60 shrink-0 tabular-nums">
                {a.time}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
