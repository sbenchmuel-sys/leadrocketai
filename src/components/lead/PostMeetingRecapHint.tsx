// PostMeetingRecapHint — "you owe them a recap" / "recap sent".
//
// Logic lifted verbatim from the deleted LeadOverviewPanel (Unit L2 removed the
// desktop-only right rail it lived in): take the latest meeting pack, look for
// an outbound email after that meeting, and say which way it went. One quiet
// line, on every screen size now — it used to be invisible on a phone.

import { useEffect, useState } from "react";
import { format, parseISO } from "date-fns";
import { AlertTriangle, Mail } from "lucide-react";
import { getLeadMeetingPacks } from "@/lib/supabaseQueries";
import { getLeadActivityFeed } from "@/lib/leadActivity";

export default function PostMeetingRecapHint({ leadId }: { leadId: string }) {
  const [state, setState] = useState<{ hasMeeting: boolean; sentAt: string | null }>({
    hasMeeting: false, sentAt: null,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [packs, activity] = await Promise.all([
          getLeadMeetingPacks(leadId),
          getLeadActivityFeed(leadId, { limit: 50 }),
        ]);
        if (cancelled) return;
        if (packs.length === 0) {
          setState({ hasMeeting: false, sentAt: null });
          return;
        }
        const meetingDate = new Date(packs[0].meeting_date || packs[0].created_at);
        const outboundAfter = activity.find(
          (a) => a.channel === "email" && a.direction === "outbound" && new Date(a.occurred_at) > meetingDate,
        );
        setState({ hasMeeting: true, sentAt: outboundAfter?.occurred_at ?? null });
      } catch (err) {
        console.error("Failed to load meeting packs:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [leadId]);

  if (!state.hasMeeting) return null;

  return state.sentAt ? (
    <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 rounded-md px-2 py-1.5">
      <Mail className="h-3 w-3 shrink-0" />
      <span className="font-medium">Post-meeting email sent</span>
      <span className="text-muted-foreground ml-auto">{format(parseISO(state.sentAt), "MMM d")}</span>
    </div>
  ) : (
    <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded-md px-2 py-1.5">
      <AlertTriangle className="h-3 w-3 shrink-0" />
      <span className="font-medium">Post-meeting recap pending</span>
    </div>
  );
}
