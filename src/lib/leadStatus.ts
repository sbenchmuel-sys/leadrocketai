// ============================================================================
// Lead status + automation helpers for the merged Leads page (Unit A).
//
// The All-leads table shows a single colored "status word" per lead for quick
// scanning, plus an On/Off "Auto" column. The filter chips (New / In automation
// / All) are derived from the SAME predicates so a chip's count can never
// disagree with what the table shows.
// ============================================================================

import type { EnrichedLead } from "@/lib/dashboardUtils";

export type LeadStatusKey = "new" | "hot" | "quiet" | "active";

export interface LeadStatusDisplay {
  key: LeadStatusKey;
  label: string;
  /** Tailwind text-color class — blue (New), amber (Hot), muted (Gone quiet). */
  className: string;
}

/**
 * True when the lead has an unanswered customer reply — its most recent inbound
 * is strictly newer than its most recent outbound. A reply auto-pauses
 * automation (the executor's instant-pause-on-inbound guardrail), so while this
 * is true the lead is effectively waiting on the rep, not on automation.
 * Mirrors the `hasUnansweredInbound` rule used on the dashboard.
 */
function hasUnansweredReply(lead: EnrichedLead): boolean {
  if (!lead.last_inbound_at) return false;
  const inbound = new Date(lead.last_inbound_at).getTime();
  const outbound = lead.last_outbound_at ? new Date(lead.last_outbound_at).getTime() : 0;
  return inbound > outbound;
}

/**
 * True when the lead is enrolled in automation AND not currently paused by a
 * reply: either an outreach campaign (campaign_id) or a consented legacy
 * sequence/nurture (automation_mode). This mirrors the consent signals the
 * executor and enrollment gate use.
 *
 * Display-only refinement (replied leads leave Automation): when the customer
 * has replied and nobody has responded yet, automation is paused, so we report
 * the lead as NOT in automation — it drops off the "Auto: On" column and the
 * "In automation" count even though its campaign_id / automation_mode are still
 * set. This does NOT touch the executor or un-enroll anything; the lead's
 * enrollment is intact and the engine's own pause-on-inbound is unchanged.
 */
/**
 * Raw enrollment signal — true when the lead is in an outreach campaign or a
 * consented legacy sequence/nurture, REGARDLESS of whether a reply has paused
 * it. Use this to answer "is this lead already enrolled?" (e.g. keeping enrolled
 * leads out of the New chip). For the display "in automation right now?"
 * question (Auto column, In-automation count) use isInAutomation, which also
 * subtracts reply-paused leads.
 */
function isEnrolled(lead: EnrichedLead): boolean {
  return !!lead.campaign_id || !!lead.automation_mode || lead.revenueState === "automation";
}

export function isInAutomation(lead: EnrichedLead): boolean {
  if (hasUnansweredReply(lead)) return false;
  return isEnrolled(lead);
}

/**
 * Derive the lead's status word. Priority: Hot (warming) → Gone quiet (stale)
 * → New (freshly added) → Active (default). Hot/Gone quiet stay visible in the
 * column even though they are not filter chips.
 */
export function leadStatus(lead: EnrichedLead): LeadStatusDisplay {
  if (lead.revenueState === "heating_up") {
    return { key: "hot", label: "Hot", className: "text-amber-600 dark:text-amber-400" };
  }
  if (lead.revenueState === "long_cycle") {
    return { key: "quiet", label: "Gone quiet", className: "text-muted-foreground" };
  }
  if (lead.stage === "new") {
    return { key: "new", label: "New", className: "text-blue-600 dark:text-blue-400" };
  }
  return { key: "active", label: "Active", className: "text-foreground/70" };
}

/**
 * "New" chip predicate: recently-added leads not yet in automation. Reuses the
 * "new lead" notion (stage 'new') and excludes anything already enrolled.
 */
export function isNewLead(lead: EnrichedLead): boolean {
  // Exclude ALREADY-ENROLLED leads even when a reply has paused them — use the
  // raw enrollment predicate, not the reply-paused display one (Codex P2 #106).
  return leadStatus(lead).key === "new" && !isEnrolled(lead);
}
