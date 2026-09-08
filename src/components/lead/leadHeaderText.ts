// Plain-English strings for the one-column lead page header (Unit L2).
// Pure — no React, no Supabase — so the wording is unit-testable.

import { differenceInDays, formatDistanceToNow, parseISO } from "date-fns";
import type { LeadDetail } from "@/lib/supabaseQueries";

function daysSince(iso: string, now: Date): number {
  return Math.max(0, differenceInDays(now, parseISO(iso)));
}

/**
 * Short status chip next to the lead's name, e.g. "Replied 2 days ago",
 * "Waiting 3 days", "Meeting booked". Same inputs as getLeadStatusLine —
 * this is the compressed, chip-sized form of it.
 */
export function buildStatusChip(lead: LeadDetail, now: Date = new Date()): string {
  const stage = lead.stage || "new";
  if (stage === "closed_won") return "Closed — won";
  if (stage === "closed_lost") return "Closed — lost";
  if (lead.has_future_meeting) return "Meeting booked";

  const inbound = lead.last_inbound_at ?? null;
  const outbound = lead.last_outbound_at ?? null;

  if (inbound && (!outbound || parseISO(inbound).getTime() >= parseISO(outbound).getTime())) {
    const d = daysSince(inbound, now);
    if (d === 0) return "Replied today";
    if (d === 1) return "Replied yesterday";
    return `Replied ${d} days ago`;
  }

  if (outbound) {
    const d = daysSince(outbound, now);
    if (d === 0) return "Waiting since today";
    if (d === 1) return "Waiting 1 day";
    return `Waiting ${d} days`;
  }

  return "No outreach yet";
}

/** "Away until Sep 12" when the lead is out of office, else null. */
export function buildAwayChip(oooUntil: string | null | undefined, now: Date = new Date()): string | null {
  if (!oooUntil) return null;
  const until = parseISO(oooUntil);
  if (!(until.getTime() > now.getTime())) return null;
  return `Away until ${until.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

/**
 * Provenance under the "What to do next" card: what the suggestion was built
 * from and when it was last refreshed. The "Update" control is rendered next
 * to this line by the header (it re-runs the same recompute the
 * "What we know" pane uses).
 *
 * ponytail: `timeline_items` counts every logged message (email, SMS,
 * WhatsApp, notes), so the copy says "messages", not "emails" — the count we
 * have is the honest one.
 */
export function buildProvenanceLine(input: {
  sourceCounts?: Record<string, number> | null;
  lastComputedAt?: string | null;
  now?: Date;
}): string {
  const counts = input.sourceCounts ?? null;
  const messages = counts?.timeline_items ?? 0;
  const meetings = counts?.meetings ?? 0;

  const parts: string[] = [];
  if (messages > 0) parts.push(`${messages} message${messages === 1 ? "" : "s"}`);
  if (meetings > 0) parts.push(`${meetings} meeting${meetings === 1 ? "" : "s"}`);

  const from = parts.length > 0 ? `From ${parts.join(" and ")}` : "Nothing to read yet";

  if (!input.lastComputedAt) return `${from} · not checked yet`;
  const checked = formatDistanceToNow(parseISO(input.lastComputedAt), { addSuffix: true });
  return `${from} · checked ${checked}`;
}
