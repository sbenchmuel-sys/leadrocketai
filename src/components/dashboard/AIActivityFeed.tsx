import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Mail, FileText, CalendarCheck, ArrowRight, Sparkles } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import type { EnrichedLead } from "@/lib/dashboardUtils";

interface AIActivityFeedProps {
  leads: EnrichedLead[];
}

interface ActivityItem {
  icon: typeof Mail;
  label: string;
  leadName: string;
  leadId: string;
  time: string;
  sortTime: number;
}

export function AIActivityFeed({ leads }: AIActivityFeedProps) {
  const activities = useMemo(() => {
    const items: ActivityItem[] = [];

    // Draft created / action pending
    leads
      .filter((l) => l.needs_action && l.next_action_label)
      .forEach((l) => {
        items.push({
          icon: FileText,
          label: "Draft created",
          leadName: l.name,
          leadId: l.id,
          time: formatDistanceToNow(new Date(l.last_activity_at), { addSuffix: true }),
          sortTime: new Date(l.last_activity_at).getTime(),
        });
      });

    // Reply detected
    leads
      .filter((l) => l.last_inbound_at)
      .forEach((l) => {
        items.push({
          icon: Mail,
          label: "Reply detected",
          leadName: l.name,
          leadId: l.id,
          time: formatDistanceToNow(new Date(l.last_inbound_at!), { addSuffix: true }),
          sortTime: new Date(l.last_inbound_at!).getTime(),
        });
      });

    // Follow-up scheduled (nurture auto)
    leads
      .filter((l) => l.nurture_mode === "auto" && l.nurture_status === "active")
      .forEach((l) => {
        items.push({
          icon: CalendarCheck,
          label: "Follow-up scheduled",
          leadName: l.name,
          leadId: l.id,
          time: "Queued",
          sortTime: 0,
        });
      });

    // Stage moves (leads with recent activity in advanced stages)
    leads
      .filter((l) => l.stage !== "new" && l.stage !== "contacted")
      .forEach((l) => {
        const lastAct = new Date(l.last_activity_at).getTime();
        const hoursSince = (Date.now() - lastAct) / (1000 * 60 * 60);
        if (hoursSince < 48) {
          items.push({
            icon: ArrowRight,
            label: `Moved to ${l.stage.replace("_", " ")}`,
            leadName: l.name,
            leadId: l.id,
            time: formatDistanceToNow(new Date(l.last_activity_at), { addSuffix: true }),
            sortTime: lastAct,
          });
        }
      });

    // Sort newest first and limit
    return items.sort((a, b) => b.sortTime - a.sortTime).slice(0, 8);
  }, [leads]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">AI Activity</h3>
      </div>

      {activities.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          No recent activity yet.
        </p>
      ) : (
        <div className="space-y-1 max-h-[320px] overflow-y-auto pr-1">
          {activities.map((a, i) => (
            <Link
              key={i}
              to={`/app/leads/${a.leadId}`}
              className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/40 transition-colors"
            >
              <div className="h-6 w-6 rounded-md bg-muted flex items-center justify-center shrink-0">
                <a.icon className="h-3 w-3 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <span className="text-xs text-foreground">
                  {a.label} — <span className="font-medium">{a.leadName}</span>
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground/60 shrink-0">
                {a.time}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
