import { differenceInDays, parseISO } from "date-fns";
import type { LeadDetail } from "@/lib/supabaseQueries";
import type { DealStage } from "@/lib/dashboardUtils";

// Plain-English, sales-language status line for the Lead Detail spine.
// Built only from signals the lead already carries — no new scoring, and
// deliberately no system words ("stage", "motion", "outbound") in the output.

function relativeDays(iso: string): string {
  const d = differenceInDays(new Date(), parseISO(iso));
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  const weeks = Math.round(d / 7);
  if (weeks === 1) return "a week ago";
  if (weeks < 9) return `${weeks} weeks ago`;
  const months = Math.round(d / 30);
  return months <= 1 ? "a month ago" : `${months} months ago`;
}

/**
 * One human sentence describing where this lead stands, e.g.
 *   "Meeting booked" · "Replied 2 days ago · warm" ·
 *   "Gone quiet · last emailed 4 days ago" · "No outreach yet".
 */
export function getLeadStatusLine(lead: LeadDetail): string {
  const stage = (lead.stage as DealStage) || "new";
  if (stage === "closed_won") return "Closed — won";
  if (stage === "closed_lost") return "Closed — lost";

  const oooUntil = (lead as any).ooo_until as string | null;
  if (oooUntil && parseISO(oooUntil).getTime() > Date.now()) {
    const until = parseISO(oooUntil).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `Out of office until ${until}`;
  }

  if (lead.has_future_meeting) return "Meeting booked";

  const inbound = lead.last_inbound_at ? parseISO(lead.last_inbound_at).getTime() : null;
  const outbound = lead.last_outbound_at ? parseISO(lead.last_outbound_at).getTime() : null;

  // They reached out and we've never written back → fresh inbound to handle.
  if (inbound !== null && outbound === null) return "New — not contacted yet";

  // They replied within our thread and it's the most recent touch → warm.
  if (inbound !== null && outbound !== null && inbound >= outbound) {
    const rel = relativeDays(lead.last_inbound_at!);
    const days = differenceInDays(new Date(), parseISO(lead.last_inbound_at!));
    return days <= 3 ? `Replied ${rel} · warm` : `Replied ${rel}`;
  }

  // We emailed last — waiting on them, or they've gone quiet.
  if (outbound !== null) {
    const days = differenceInDays(new Date(), parseISO(lead.last_outbound_at!));
    return days <= 3
      ? `Waiting on a reply · emailed ${relativeDays(lead.last_outbound_at!)}`
      : `Gone quiet · last emailed ${relativeDays(lead.last_outbound_at!)}`;
  }

  // Nothing emailed either way.
  if (lead.last_activity_at) return `Quiet · last activity ${relativeDays(lead.last_activity_at)}`;
  return "No outreach yet";
}
