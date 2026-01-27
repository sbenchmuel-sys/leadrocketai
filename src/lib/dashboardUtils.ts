// Dashboard utility functions for stage display and AI recommendations

import type { LeadListItem } from "./supabaseQueries";
import { differenceInDays, subDays, parseISO } from "date-fns";

// Deal flow stages
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
}): EnrichedLead {
  return {
    ...lead,
    stage: (lead.stage as DealStage) || "new",
    needs_action: lead.needs_action || false,
    next_action_key: lead.next_action_key || null,
    next_action_label: lead.next_action_label || null,
    hasMeeting: (lead.meeting_summary_count || 0) > 0,
    last_outbound_at: lead.last_outbound_at || null,
    last_inbound_at: lead.last_inbound_at || null,
    first_outbound_at: lead.first_outbound_at || null,
  };
}

// Get action type from action key for button rendering
export function getActionType(actionKey: string | null): "reply" | "follow_up" | "recap" | "nurture" | "closing" | "view" {
  if (!actionKey) return "view";
  if (actionKey === "reply_now") return "reply";
  if (actionKey.startsWith("send_pre_")) return "follow_up";
  if (actionKey === "generate_post_meeting_recap") return "recap";
  if (actionKey.startsWith("send_nurture_")) return "nurture";
  if (actionKey === "send_proposal" || actionKey === "closing_followup") return "closing";
  return "view";
}

// ============================================
// INTELLIGENCE METRICS
// ============================================

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
      };
      const aPriority = priority[a.next_action_key || ""] || 10;
      const bPriority = priority[b.next_action_key || ""] || 10;
      return aPriority - bPriority;
    })
    .slice(0, 3);

  return actionable.map((l) => {
    const actionType = getActionType(l.next_action_key);
    
    if (actionType === "reply") {
      return `Reply to ${l.name} at ${l.company} — they're waiting for your response.`;
    }
    if (actionType === "recap") {
      return `Send ${l.name} a post-meeting follow-up to keep momentum.`;
    }
    if (actionType === "closing") {
      return `${l.name} at ${l.company} is in closing — ${l.next_action_label}.`;
    }
    if (actionType === "follow_up") {
      return `Follow up with ${l.name} at ${l.company} — ${l.next_action_label}.`;
    }
    if (actionType === "nurture") {
      return `Continue nurturing ${l.name} at ${l.company} with the next email.`;
    }
    return `Check in on ${l.name} at ${l.company}.`;
  });
}
