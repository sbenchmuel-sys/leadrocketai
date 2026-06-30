// ============================================================================
// Upcoming touches — forward-looking view of scheduled cold campaign touches.
//
// The Outreach tab only lists touches currently `queued` and due. Leads that
// are enrolled but parked waiting for their next eligibility window (e.g. a
// 1-day delay between steps, or auto-skipped previous step) silently disappear
// from the rep's view until the cron promotes them. This module powers the
// "Upcoming touches" strip that surfaces those scheduled rows, grouped by
// campaign so 100 enrolled leads collapse into a single row.
// ============================================================================

import { supabase } from "@/integrations/supabase/client";

export type UpcomingChannel = "email" | "voice" | "sms" | "whatsapp" | "linkedin";

export interface UpcomingLead {
  touchId: string;
  leadId: string;
  leadName: string;
  company: string | null;
  channel: UpcomingChannel;
  stepNumber: number;
  readyAt: string; // ISO
  /** Inferred reason the previous step was auto-skipped, if any. */
  previousSkipReason: string | null;
}

export interface UpcomingCampaignGroup {
  campaignId: string;
  campaignName: string;
  leadCount: number;
  nextReadyAt: string; // earliest readyAt in group
  /** Summary like ["12 missing LinkedIn URL", "3 missing phone"]. */
  skipReasonSummary: string[];
  leads: UpcomingLead[];
}

/** Map a skipped touch's channel to a human reason. */
function reasonForChannel(channel: string): string | null {
  switch (channel) {
    case "linkedin": return "missing LinkedIn URL";
    case "voice":    return "missing phone";
    case "sms":      return "missing phone";
    case "whatsapp": return "missing WhatsApp number";
    case "email":    return "missing email";
    default:         return null;
  }
}

export async function fetchUpcomingTouches(): Promise<UpcomingCampaignGroup[]> {
  // Active campaigns the rep can see (RLS scopes).
  const { data: activeCamps } = await supabase
    .from("campaigns")
    .select("id, name")
    .eq("status", "active");
  const campMap = new Map(((activeCamps || []) as any[]).map((c) => [c.id, c.name as string]));
  const activeIds = [...campMap.keys()];
  if (activeIds.length === 0) return [];

  // Pull scheduled (not yet due / not yet queued) touches belonging to ACTIVE
  // enrollments only, owner-scoped via the leads!inner join.
  const { data: touches } = await supabase
    .from("campaign_touch" as any)
    .select(
      "id, campaign_id, lead_id, step_number, channel, eligible_at, enrollment_id, " +
        "leads!inner(id, name, company), " +
        "campaign_enrollment!inner(id, status)",
    )
    .eq("status", "scheduled")
    .eq("campaign_enrollment.status", "active")
    .in("campaign_id", activeIds)
    .order("eligible_at", { ascending: true })
    .limit(500);

  const rows = (touches || []) as any[];
  if (rows.length === 0) return [];

  // Look up immediately-preceding auto_skipped touches (same enrollment, lower
  // step_number) to surface skip reasons inline.
  const enrollmentIds = [...new Set(rows.map((r) => r.enrollment_id).filter(Boolean))];
  const skipMap = new Map<string, string>(); // enrollment_id -> last skipped channel
  if (enrollmentIds.length > 0) {
    const { data: skipped } = await supabase
      .from("campaign_touch" as any)
      .select("enrollment_id, channel, step_number")
      .in("enrollment_id", enrollmentIds)
      .eq("status", "auto_skipped")
      .order("step_number", { ascending: false });
    for (const s of ((skipped || []) as any[])) {
      // First write wins because we ordered DESC — keep the most recent skip.
      if (!skipMap.has(s.enrollment_id)) skipMap.set(s.enrollment_id, s.channel);
    }
  }

  // Group by campaign.
  const byCamp = new Map<string, UpcomingLead[]>();
  for (const t of rows) {
    const lead = Array.isArray(t.leads) ? t.leads[0] : t.leads;
    if (!lead) continue;
    const skipChan = skipMap.get(t.enrollment_id);
    const upcoming: UpcomingLead = {
      touchId: t.id,
      leadId: t.lead_id,
      leadName: lead.name || "—",
      company: lead.company ?? null,
      channel: t.channel,
      stepNumber: t.step_number,
      readyAt: t.eligible_at,
      previousSkipReason: skipChan ? reasonForChannel(skipChan) : null,
    };
    const list = byCamp.get(t.campaign_id) || [];
    list.push(upcoming);
    byCamp.set(t.campaign_id, list);
  }

  const groups: UpcomingCampaignGroup[] = [];
  for (const [campaignId, leads] of byCamp.entries()) {
    // Tally skip reasons.
    const counts = new Map<string, number>();
    for (const l of leads) {
      if (!l.previousSkipReason) continue;
      counts.set(l.previousSkipReason, (counts.get(l.previousSkipReason) || 0) + 1);
    }
    const summary = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, n]) => `${n} ${reason}`);
    groups.push({
      campaignId,
      campaignName: campMap.get(campaignId) || "Outreach",
      leadCount: leads.length,
      nextReadyAt: leads[0].readyAt, // already sorted asc by eligible_at
      skipReasonSummary: summary,
      leads,
    });
  }
  groups.sort((a, b) => (a.nextReadyAt || "").localeCompare(b.nextReadyAt || ""));
  return groups;
}

/** Humanize an ISO timestamp into "Today 9:00 AM" / "Tomorrow 2:30 PM" / "Mon, Jul 6 9:00 AM". */
export function formatReadyAt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today ${time}`;
  if (isTomorrow) return `Tomorrow ${time}`;
  const date = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return `${date} ${time}`;
}
