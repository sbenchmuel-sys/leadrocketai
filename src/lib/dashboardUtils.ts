// Dashboard utility functions for stage display and AI recommendations

import type { LeadListItem } from "./supabaseQueries";
import { differenceInDays, subDays, parseISO } from "date-fns";

// Deal flow stages (internal)
export type DealStage = "new" | "contacted" | "engaged" | "post_meeting" | "closing" | "closed_won" | "closed_lost";

export const STAGE_LABELS: Record<DealStage, string> = {
  new: "New",
  contacted: "Contacted",
  engaged: "Engaged",
  post_meeting: "Post-Meeting",
  closing: "Closing",
  closed_won: "Won",
  closed_lost: "Lost",
};

// Only show these stages in the flow bar (exclude closed states)
export const STAGE_ORDER: DealStage[] = ["new", "contacted", "engaged", "post_meeting", "closing"];

// ============================================
// SOURCE TYPE & MOTION
// ============================================

export type SourceType = "outbound_prospecting" | "contact_form" | "gmail_inbound" | "event_lead" | "referral" | "csv_import" | "manual_entry";

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  outbound_prospecting: "Outbound Prospect",
  contact_form: "Inbound – Website",
  gmail_inbound: "Inbound – Direct Email",
  event_lead: "Event Lead",
  referral: "Referral",
  csv_import: "Outbound – CSV",
  manual_entry: "Manual",
};

export const SOURCE_TYPE_COLORS: Record<SourceType, { dot: string; bg: string; text: string; bar: string }> = {
  outbound_prospecting: { dot: "bg-blue-500", bg: "bg-blue-50 dark:bg-blue-950/40", text: "text-blue-700 dark:text-blue-300", bar: "bg-blue-500" },
  contact_form:         { dot: "bg-green-500", bg: "bg-green-50 dark:bg-green-950/40", text: "text-green-700 dark:text-green-300", bar: "bg-green-500" },
  gmail_inbound:        { dot: "bg-green-500", bg: "bg-green-50 dark:bg-green-950/40", text: "text-green-700 dark:text-green-300", bar: "bg-green-500" },
  event_lead:           { dot: "bg-purple-500", bg: "bg-purple-50 dark:bg-purple-950/40", text: "text-purple-700 dark:text-purple-300", bar: "bg-purple-500" },
  referral:             { dot: "bg-yellow-500", bg: "bg-yellow-50 dark:bg-yellow-950/40", text: "text-yellow-700 dark:text-yellow-300", bar: "bg-yellow-500" },
  csv_import:           { dot: "bg-blue-500", bg: "bg-blue-50 dark:bg-blue-950/40", text: "text-blue-700 dark:text-blue-300", bar: "bg-blue-500" },
  manual_entry:         { dot: "bg-muted-foreground", bg: "bg-muted/50", text: "text-muted-foreground", bar: "bg-muted-foreground/50" },
};

export type Motion = "outbound_prospecting" | "inbound_response" | "pre_meeting" | "post_meeting" | "closing" | "nurture" | "closed";

export const MOTION_LABELS: Record<Motion, string> = {
  outbound_prospecting: "Prospecting",
  inbound_response: "Engaged",
  pre_meeting: "Pre-Meeting",
  post_meeting: "Post-Meeting",
  closing: "Closing",
  nurture: "Nurture",
  closed: "Closed",
};

export const MOTION_ICONS: Record<Motion, string> = {
  outbound_prospecting: "🚀",
  inbound_response: "💬",
  pre_meeting: "📅",
  post_meeting: "📝",
  closing: "🤝",
  nurture: "🌱",
  closed: "🏁",
};

export const MOTION_COLORS: Record<Motion, { bg: string; text: string }> = {
  outbound_prospecting: { bg: "bg-blue-100 dark:bg-blue-900/40", text: "text-blue-800 dark:text-blue-200" },
  inbound_response: { bg: "bg-emerald-100 dark:bg-emerald-900/40", text: "text-emerald-800 dark:text-emerald-200" },
  pre_meeting: { bg: "bg-indigo-100 dark:bg-indigo-900/40", text: "text-indigo-800 dark:text-indigo-200" },
  post_meeting: { bg: "bg-violet-100 dark:bg-violet-900/40", text: "text-violet-800 dark:text-violet-200" },
  closing: { bg: "bg-amber-100 dark:bg-amber-900/40", text: "text-amber-800 dark:text-amber-200" },
  nurture: { bg: "bg-teal-100 dark:bg-teal-900/40", text: "text-teal-800 dark:text-teal-200" },
  closed: { bg: "bg-muted", text: "text-muted-foreground" },
};

// ============================================
// ORIGIN CATEGORY (derived, simplifies UI logic)
// ============================================

export type OriginCategory = "outbound" | "inbound";

export function getOriginCategory(sourceType: SourceType): OriginCategory {
  switch (sourceType) {
    case "contact_form":
    case "gmail_inbound":
    case "referral":
      return "inbound";
    default:
      return "outbound";
  }
}

// Source presets: auto-assign motion based on source selection
export interface SourcePreset {
  source_type: SourceType;
  motion: Motion;
  origin: OriginCategory;
}

export const SOURCE_PRESETS: Record<string, SourcePreset> = {
  outbound: {
    source_type: "outbound_prospecting",
    motion: "outbound_prospecting",
    origin: "outbound",
  },
  inbound_website: {
    source_type: "contact_form",
    motion: "inbound_response",
    origin: "inbound",
  },
  event: {
    source_type: "event_lead",
    motion: "outbound_prospecting",
    origin: "outbound",
  },
  referral: {
    source_type: "referral",
    motion: "inbound_response",
    origin: "inbound",
  },
  other: {
    source_type: "manual_entry",
    motion: "outbound_prospecting",
    origin: "outbound",
  },
};



export type DisplayPhase = "Prospecting" | "Engaged" | "Post-Meeting" | "Closing" | "Nurture" | "Closed";

export function getDisplayPhase(stage: DealStage, motion?: Motion): DisplayPhase {
  // If motion is nurture, always show Nurture
  if (motion === "nurture") return "Nurture";
  if (motion === "closed") return "Closed";

  switch (stage) {
    case "new":
    case "contacted":
      return "Prospecting";
    case "engaged":
      return "Engaged";
    case "post_meeting":
      return "Post-Meeting";
    case "closing":
      return "Closing";
    case "closed_won":
    case "closed_lost":
      return "Closed";
    default:
      return "Prospecting";
  }
}

export const DISPLAY_PHASE_ORDER: DisplayPhase[] = ["Prospecting", "Engaged", "Post-Meeting", "Closing", "Nurture", "Closed"];

// Stage progression order for momentum calculation
const STAGE_PROGRESSION_ORDER: DealStage[] = ["new", "contacted", "engaged", "post_meeting", "closing", "closed_won"];

// ============================================
// REVENUE CONTROL STATES
// ============================================

export type RevenueState = "action_required" | "heating_up" | "long_cycle" | "active" | "automation";

export const REVENUE_STATE_LABELS: Record<RevenueState, string> = {
  action_required: "Action Required",
  heating_up: "Heating Up",
  long_cycle: "Long Cycle",
  active: "Active",
  automation: "Automation",
};

/**
 * Classify a lead into exactly ONE Revenue State.
 * Priority order (highest → lowest): Action Required > Heating Up > Long Cycle > Active.
 *
 * Must be called AFTER enrichment so hasMeeting / stage / needs_action are populated.
 * warmingUpIds is a pre-computed set from deriveWarmingUpLeads for consistency.
 */
export function classifyRevenueState(
  lead: EnrichedLead,
  warmingUpIds: Set<string>
): RevenueState {
  // --- 0. AUTOMATION (highest priority — divert automated leads) ---
  const hasSequenceAutomation = !!lead.eligible_at && lead.needs_action;
  const hasNurtureAutomation = lead.nurture_mode === "auto" && lead.nurture_status === "active";
  if (hasSequenceAutomation || hasNurtureAutomation) return "automation";

  // --- 1. ACTION REQUIRED ---
  if (lead.needs_action) return "action_required";
  // Unreplied inbound (has inbound but last outbound is before last inbound)
  if (lead.last_inbound_at) {
    const inboundTs = new Date(lead.last_inbound_at).getTime();
    const outboundTs = lead.last_outbound_at ? new Date(lead.last_outbound_at).getTime() : 0;
    if (inboundTs > outboundTs) return "action_required";
  }
  // Meeting completed with no follow-up sent (post_meeting stage, no outbound after meeting)
  if (lead.stage === "post_meeting" && lead.hasMeeting) {
    const lastActivity = new Date(lead.last_activity_at).getTime();
    const lastOutbound = lead.last_outbound_at ? new Date(lead.last_outbound_at).getTime() : 0;
    if (lastOutbound < lastActivity) return "action_required";
  }

  // --- 2. HEATING UP ---
  if (warmingUpIds.has(lead.id)) return "heating_up";

  // --- 3. LONG CYCLE ---
  const now = new Date();
  const createdDaysAgo = lead.created_at
    ? differenceInDays(now, parseISO(lead.created_at))
    : 0;
  const isLongCycle =
    createdDaysAgo > 60 &&
    lead.stage !== "closed_won" &&
    lead.stage !== "closed_lost";
  // Long cycle only if genuinely inactive (>14 days silence), regardless of motion
  if (isLongCycle) {
    const lastActDays = lead.last_activity_at
      ? differenceInDays(now, parseISO(lead.last_activity_at))
      : 999;
    if (lastActDays > 14) return "long_cycle";
  }

  // --- 4. ACTIVE (default) ---
  return "active";
}

export interface EnrichedLead extends LeadListItem {
  stage: DealStage;
  needs_action: boolean;
  next_action_key: string | null;
  next_action_label: string | null;
  hasMeeting: boolean;
  last_outbound_at: string | null;
  last_inbound_at?: string | null;
  first_outbound_at?: string | null;
  source_type: SourceType;
  motion: Motion;
  displayPhase: DisplayPhase;
  origin_category: OriginCategory;
  nurture_mode?: string;
  nurture_status?: string;
  eligible_at?: string | null;
  revenueState?: RevenueState;
}

// Enrich lead with data from database fields (no local derivation needed anymore)
export function enrichLead(lead: LeadListItem & {
  stage?: string;
  needs_action?: boolean;
  next_action_key?: string | null;
  next_action_label?: string | null;
  meeting_summary_count?: number;
  last_outbound_at?: string | null;
  last_inbound_at?: string | null;
  first_outbound_at?: string | null;
  source_type?: string;
  motion?: string;
  nurture_mode?: string;
  nurture_status?: string;
  eligible_at?: string | null;
}): EnrichedLead {
  const stage = (lead.stage as DealStage) || "new";
  const sourceType = (lead.source_type as SourceType) || "manual_entry";
  const motion = (lead.motion as Motion) || "outbound_prospecting";
  return {
    ...lead,
    stage,
    needs_action: lead.needs_action || false,
    next_action_key: lead.next_action_key || null,
    next_action_label: lead.next_action_label || null,
    hasMeeting: (lead.meeting_summary_count || 0) > 0,
    last_outbound_at: lead.last_outbound_at || null,
    last_inbound_at: lead.last_inbound_at || null,
    first_outbound_at: lead.first_outbound_at || null,
    source_type: sourceType,
    motion,
    displayPhase: getDisplayPhase(stage, motion),
    origin_category: getOriginCategory(sourceType),
    nurture_mode: lead.nurture_mode,
    nurture_status: lead.nurture_status,
    eligible_at: lead.eligible_at,
  };
}

// Get action type from action key for button rendering
export function getActionType(actionKey: string | null): "reply" | "follow_up" | "recap" | "nurture" | "closing" | "view" {
  if (!actionKey) return "view";
  if (actionKey === "reply_now") return "reply";
  if (actionKey.startsWith("send_pre_")) return "follow_up";
  if (actionKey === "generate_post_meeting_recap") return "recap";
  if (actionKey === "post_meeting_followup") return "follow_up";
  if (actionKey.startsWith("send_nurture_")) return "nurture";
  if (actionKey === "send_proposal" || actionKey === "closing_followup") return "closing";
  return "view";
}

// ============================================
// INTELLIGENCE METRICS
// ============================================

/**
 * Get leads that are eligible for nurture mode switch
 * - In "fast" strategy
 * - Have sent 3+ outbound emails (estimated by looking at first/last outbound)
 * - Have no inbound replies
 * - Not in closing/closed stages
 */
export function getNurtureCandidates(leads: EnrichedLead[]): EnrichedLead[] {
  return leads.filter((lead) => {
    // Must be in outbound or inbound motion (not already nurture)
    if (lead.motion !== "outbound_prospecting" && lead.motion !== "inbound_response") {
      return false;
    }
    
    // Skip closed leads
    if (lead.stage === "closed_won" || lead.stage === "closed_lost" || lead.stage === "closing") {
      return false;
    }
    
    // Must have first outbound (means we've contacted them)
    if (!lead.first_outbound_at) {
      return false;
    }
    
    // No inbound means no reply
    if (lead.last_inbound_at) {
      return false;
    }
    
    // Check if auto_nurture_eligible is set (from backend)
    if ((lead as any).auto_nurture_eligible) {
      return true;
    }
    
    // Fallback: estimate based on time since first outbound (if > 10 days, likely multiple follow-ups sent)
    const now = new Date();
    const firstOutbound = new Date(lead.first_outbound_at);
    const daysSinceFirst = differenceInDays(now, firstOutbound);
    return daysSinceFirst >= 10;
  });
}

/**
 * Get leads that are "stale" - no outbound contact in >14 days and not closed
 */
export function getStaleLeads(leads: EnrichedLead[]): EnrichedLead[] {
  const now = new Date();
  const cutoffDays = 14;
  
  return leads.filter((lead) => {
    // Skip closed leads
    if (lead.stage === "closed_won" || lead.stage === "closed_lost") {
      return false;
    }
    
    // Check last_outbound_at
    if (!lead.last_outbound_at) {
      // If never contacted and created >14 days ago, it's stale
      if (lead.created_at) {
        const daysSinceCreated = differenceInDays(now, parseISO(lead.created_at));
        return daysSinceCreated > cutoffDays;
      }
      return false;
    }
    
    const daysSinceOutbound = differenceInDays(now, parseISO(lead.last_outbound_at));
    return daysSinceOutbound > cutoffDays;
  });
}

/**
 * Calculate momentum - net stage progressions in the last 7 days
 * Positive = more forward moves than backward
 * This is a simplified version that counts leads by recency
 * A full implementation would track stage change history
 */
export function calculateMomentum(leads: EnrichedLead[]): number {
  // For now, we approximate momentum based on:
  // - Leads that moved to a later stage recently (positive)
  // - Leads in "new" stage for >7 days (negative)
  const now = new Date();
  const sevenDaysAgo = subDays(now, 7);
  
  let momentum = 0;
  
  leads.forEach((lead) => {
    // Skip closed leads
    if (lead.stage === "closed_won" || lead.stage === "closed_lost") {
      return;
    }
    
    const lastActivity = lead.last_activity_at ? parseISO(lead.last_activity_at) : null;
    
    // If lead has recent activity and is past "new" stage, count as positive
    if (lastActivity && lastActivity >= sevenDaysAgo) {
      const stageIndex = STAGE_PROGRESSION_ORDER.indexOf(lead.stage);
      if (stageIndex > 0) {
        momentum += 1; // Forward movement indicator
      }
    }
    
    // If lead is "new" and hasn't been touched in 7 days, count as negative
    if (lead.stage === "new") {
      if (!lastActivity || lastActivity < sevenDaysAgo) {
        momentum -= 1;
      }
    }
  });
  
  return momentum;
}

/**
 * Calculate reply rate - percentage of leads that replied to outreach
 * Based on leads with both outbound and inbound activity
 */
export function calculateReplyRate(leads: EnrichedLead[]): number {
  // Count leads with at least one outbound
  const leadsWithOutbound = leads.filter(
    (lead) => lead.first_outbound_at || lead.last_outbound_at
  );
  
  if (leadsWithOutbound.length === 0) {
    return 0;
  }
  
  // Count leads that have inbound activity (replied)
  const leadsWithReply = leadsWithOutbound.filter(
    (lead) => lead.last_inbound_at
  );
  
  return Math.round((leadsWithReply.length / leadsWithOutbound.length) * 100);
}

// ============================================
// AI RECOMMENDATIONS
// ============================================

// Get AI recommendation summary
export function getAIRecommendation(leads: EnrichedLead[]): string[] {
  const recommendations: string[] = [];
  
  // First, check for nurture candidates that need mode switching
  const nurtureCandidates = getNurtureCandidates(leads);
  if (nurtureCandidates.length > 0) {
    const lead = nurtureCandidates[0];
    recommendations.push(
      `Consider moving ${lead.name} to nurture mode — no response after multiple follow-ups.`
    );
  }
  
  // Then get regular actionable items
  const actionable = leads
    .filter((l) => l.needs_action && l.next_action_label)
    .sort((a, b) => {
      // Prioritize replies > recaps > closing > follow-ups > nurture
      const priority: Record<string, number> = { 
        reply_now: 1, 
        generate_post_meeting_recap: 2,
        send_proposal: 3,
        closing_followup: 3,
        send_pre_2: 4,
        send_pre_3: 5,
        send_pre_4: 6,
        reengage: 7,
      };
      const aPriority = priority[a.next_action_key || ""] || 10;
      const bPriority = priority[b.next_action_key || ""] || 10;
      return aPriority - bPriority;
    })
    .slice(0, 3 - recommendations.length);

  for (const l of actionable) {
    const actionType = getActionType(l.next_action_key);
    
    if (actionType === "reply") {
      recommendations.push(`Reply to ${l.name} at ${l.company} — they're waiting for your response.`);
    } else if (actionType === "recap") {
      recommendations.push(`Send ${l.name} a post-meeting follow-up to keep momentum.`);
    } else if (actionType === "closing") {
      recommendations.push(`${l.name} at ${l.company} is in closing — ${l.next_action_label}.`);
    } else if (actionType === "follow_up") {
      recommendations.push(`Follow up with ${l.name} at ${l.company} — ${l.next_action_label}.`);
    } else if (actionType === "nurture") {
      recommendations.push(`Continue nurturing ${l.name} at ${l.company} with the next email.`);
    } else if (l.next_action_key === "reengage") {
      recommendations.push(`Re-engage ${l.name} at ${l.company} — they've been quiet for 45+ days.`);
    } else {
      recommendations.push(`Check in on ${l.name} at ${l.company}.`);
    }
  }
  
  return recommendations;
}
