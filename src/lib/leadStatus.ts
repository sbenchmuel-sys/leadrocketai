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
 * True when the lead is enrolled in automation: either an outreach campaign
 * (campaign_id) or a consented legacy sequence/nurture (automation_mode). This
 * mirrors the consent signals the executor and enrollment gate use.
 */
export function isInAutomation(lead: EnrichedLead): boolean {
  return !!lead.campaign_id || !!lead.automation_mode || lead.revenueState === "automation";
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
  return leadStatus(lead).key === "new" && !isInAutomation(lead);
}
