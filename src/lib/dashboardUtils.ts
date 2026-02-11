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
  outbound_prospecting: "Outbound",
  contact_form: "Contact Form",
  gmail_inbound: "Inbound Email",
  event_lead: "Event",
  referral: "Referral",
  csv_import: "CSV Import",
  manual_entry: "Manual",
};

export type Motion = "outbound_prospecting" | "inbound_response" | "pre_meeting" | "post_meeting" | "closing" | "nurture" | "closed";

export const MOTION_LABELS: Record<Motion, string> = {
  outbound_prospecting: "Outbound",
  inbound_response: "Inbound",
  pre_meeting: "Pre-Meeting",
  post_meeting: "Post-Meeting",
  closing: "Closing",
  nurture: "Nurture",
  closed: "Closed",
};

// ============================================
// DISPLAY PHASE MAPPER (visual layer only)
// ============================================

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
    // Must be in fast strategy
    if ((lead as any).strategy !== "fast") {
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
