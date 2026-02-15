/**
 * Dashboard Metrics Service
 * 
 * Centralised data layer that derives all dashboard KPIs from lead state.
 * UI components consume DashboardMetrics; they never query leads directly.
 */

import { supabase } from "@/integrations/supabase/client";
import { differenceInDays, parseISO } from "date-fns";
import type { EnrichedLead, DealStage, Motion, RevenueState } from "@/lib/dashboardUtils";
import { enrichLead, classifyRevenueState } from "@/lib/dashboardUtils";

// ============================================
// TYPES
// ============================================

export type RefreshReason =
  | "email_sent"
  | "meeting_logged"
  | "reply_synced"
  | "motion_updated"
  | "strategy_changed"
  | "source_updated"
  | "automation_send"
  | "manual";

export interface DashboardMetrics {
  /** Leads with needs_action = true */
  needs_action_count: number;
  /** Leads not in closed states */
  active_count: number;
  /** Leads with active automation (nurture_mode = 'auto' & nurture_status = 'active') */
  automation_running_count: number;
  /** Net forward-momentum score (positive = healthy pipeline) — kept for sub-components */
  momentum_score: number;
  /** Leads with no outbound in >14 days, not closed */
  stale_count: number;
  /** Leads eligible for nurture switch (fast strategy, no reply, 10+ days) */
  nurture_ready_count: number;
  /** Leads showing engagement + buying progress signals */
  warming_up_count: number;

  // Revenue State counts
  revenueStateCounts: Record<RevenueState, number>;

  // Underlying data for components that still need it
  leads: EnrichedLead[];
  staleLeads: EnrichedLead[];
  nurtureCandidates: EnrichedLead[];
  warmingUpLeads: EnrichedLead[];
}

// ============================================
// LEAD FETCH
// ============================================

const DASHBOARD_LEAD_COLUMNS = `
  id, company, name, email, status, owner_user_id,
  created_at, last_activity_at, next_step, deal_outlook, country,
  stage, needs_action, next_action_key, next_action_label, action_reason_code,
  meeting_summary_count, last_outbound_at, last_inbound_at, first_outbound_at,
  nurture_cadence, auto_nurture_eligible, source_type, motion,
  nurture_mode, nurture_status, eligible_at
`;

async function fetchLeads(): Promise<EnrichedLead[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("leads")
    .select(DASHBOARD_LEAD_COLUMNS)
    .order("last_activity_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("[dashboardMetrics] fetch error:", error);
    return [];
  }

  return (data || []).map(enrichLead);
}

// ============================================
// METRIC DERIVATION
// ============================================

function deriveStaleLeads(leads: EnrichedLead[]): EnrichedLead[] {
  const now = new Date();
  const STALE_DAYS = 14;

  return leads.filter((lead) => {
    if (lead.stage === "closed_won" || lead.stage === "closed_lost") return false;

    if (!lead.last_outbound_at) {
      if (lead.created_at) {
        return differenceInDays(now, parseISO(lead.created_at)) > STALE_DAYS;
      }
      return false;
    }
    return differenceInDays(now, parseISO(lead.last_outbound_at)) > STALE_DAYS;
  });
}

function deriveNurtureCandidates(leads: EnrichedLead[]): EnrichedLead[] {
  const now = new Date();

  return leads.filter((lead) => {
    // Must be in outbound or inbound motion (not already nurture)
    if (lead.motion !== "outbound_prospecting" && lead.motion !== "inbound_response") return false;
    if (lead.stage === "closed_won" || lead.stage === "closed_lost" || lead.stage === "closing") return false;
    if (!lead.first_outbound_at) return false;
    if (lead.last_inbound_at) return false;

    if ((lead as any).auto_nurture_eligible) return true;

    const daysSinceFirst = differenceInDays(now, new Date(lead.first_outbound_at));
    return daysSinceFirst >= 10;
  });
}

function deriveMomentumScore(leads: EnrichedLead[]): number {
  const now = new Date();
  const WINDOW_DAYS = 7;
  let score = 0;

  const STAGE_INDEX: Record<string, number> = {
    new: 0, contacted: 1, engaged: 2, post_meeting: 3, closing: 4, closed_won: 5,
  };

  for (const lead of leads) {
    if (lead.stage === "closed_won" || lead.stage === "closed_lost") continue;

    const lastActivity = lead.last_activity_at ? parseISO(lead.last_activity_at) : null;
    const withinWindow = lastActivity && differenceInDays(now, lastActivity) <= WINDOW_DAYS;

    // Forward motion signal
    if (withinWindow && (STAGE_INDEX[lead.stage] ?? 0) > 0) {
      score += 1;
    }

    // Stagnation signal
    if (lead.stage === "new" && (!lastActivity || !withinWindow)) {
      score -= 1;
    }
  }

  return score;
}

function deriveAutomationRunningCount(leads: EnrichedLead[]): number {
  return leads.filter((lead) => {
    const raw = lead as any;
    // Active automation = has a future eligible_at AND needs_action is true
    // Also count nurture auto mode as automation running
    const hasSequenceAutomation = !!raw.eligible_at && raw.needs_action;
    const hasNurtureAutomation = raw.nurture_mode === "auto" && raw.nurture_status === "active";
    return hasSequenceAutomation || hasNurtureAutomation;
  }).length;
}

/**
 * Derive "Warming Up" leads — deterministic, rule-based.
 * Requires BOTH an engagement signal AND a progress signal.
 */
function deriveWarmingUpLeads(leads: EnrichedLead[]): EnrichedLead[] {
  const now = new Date();

  return leads.filter((lead) => {
    if (lead.stage === "closed_won" || lead.stage === "closed_lost") return false;

    // --- Engagement signals (at least one) ---
    let hasEngagement = false;

    // Reply within last 72 hours
    if (lead.last_inbound_at) {
      const hoursSinceReply = (now.getTime() - new Date(lead.last_inbound_at).getTime()) / (1000 * 60 * 60);
      if (hoursSinceReply <= 72) hasEngagement = true;
    }

    // Fast reply latency (<24h between outbound and inbound)
    if (!hasEngagement && lead.last_outbound_at && lead.last_inbound_at) {
      const outbound = new Date(lead.last_outbound_at).getTime();
      const inbound = new Date(lead.last_inbound_at).getTime();
      if (inbound > outbound && (inbound - outbound) / (1000 * 60 * 60) < 24) {
        hasEngagement = true;
      }
    }

    // Recent activity burst (proxy: last_activity within 3 days AND has inbound)
    if (!hasEngagement && lead.last_activity_at && lead.last_inbound_at) {
      const hoursSinceActivity = (now.getTime() - new Date(lead.last_activity_at).getTime()) / (1000 * 60 * 60);
      if (hoursSinceActivity <= 72) hasEngagement = true;
    }

    if (!hasEngagement) return false;

    // --- Progress signals (at least one) ---
    // Meeting scheduled / post-meeting
    if (lead.hasMeeting || lead.stage === "post_meeting") return true;
    // Closing stage = pricing/proposal discussed
    if (lead.stage === "closing") return true;
    // Deal outlook contains progress keywords
    const outlook = ((lead as any).deal_outlook || "").toLowerCase();
    const progressKeywords = ["pricing", "decision", "budget", "procurement", "security", "follow-up", "proposal", "contract"];
    if (progressKeywords.some((kw) => outlook.includes(kw))) return true;
    // Deal factors contain progress signals
    const factors = (lead as any).deal_factors_json;
    if (factors && typeof factors === "object") {
      const factorStr = JSON.stringify(factors).toLowerCase();
      if (progressKeywords.some((kw) => factorStr.includes(kw))) return true;
    }

    return false;
  });
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Fetch leads and compute all dashboard metrics in one call.
 * `workspace_id` is accepted for future multi-workspace support
 * but currently unused (RLS scopes to auth.uid()).
 */
export async function getDashboardMetrics(
  _workspace_id?: string
): Promise<DashboardMetrics> {
  const leads = await fetchLeads();

  const staleLeads = deriveStaleLeads(leads);
  const nurtureCandidates = deriveNurtureCandidates(leads);
  const warmingUpLeads = deriveWarmingUpLeads(leads);
  const warmingUpIds = new Set(warmingUpLeads.map((l) => l.id));

  // Classify every lead into a Revenue State and stamp it
  const openLeads = leads.filter(
    (l) => l.stage !== "closed_won" && l.stage !== "closed_lost"
  );

  const revenueStateCounts: Record<RevenueState, number> = {
    active: 0,
    action_required: 0,
    heating_up: 0,
    long_cycle: 0,
    automation: 0,
  };

  for (const lead of leads) {
    if (lead.stage === "closed_won" || lead.stage === "closed_lost") {
      lead.revenueState = undefined;
      continue;
    }
    const state = classifyRevenueState(lead, warmingUpIds);
    lead.revenueState = state;
    revenueStateCounts[state]++;
  }

  return {
    needs_action_count: leads.filter((l) => l.needs_action).length,
    active_count: openLeads.length,
    automation_running_count: deriveAutomationRunningCount(leads),
    momentum_score: deriveMomentumScore(leads),
    stale_count: staleLeads.length,
    nurture_ready_count: nurtureCandidates.length,
    warming_up_count: warmingUpLeads.length,
    revenueStateCounts,
    leads,
    staleLeads,
    nurtureCandidates,
    warmingUpLeads,
  };
}

// ============================================
// REFRESH TRIGGER
// ============================================

type RefreshCallback = (reason: RefreshReason, metrics: DashboardMetrics) => void;

let _listeners: RefreshCallback[] = [];

/** Register a callback that fires after every refreshDashboard() */
export function onDashboardRefresh(cb: RefreshCallback): () => void {
  _listeners.push(cb);
  return () => {
    _listeners = _listeners.filter((l) => l !== cb);
  };
}

/**
 * Re-fetch leads, recompute metrics, and notify all listeners.
 * Call after email_sent, meeting_logged, reply_synced, motion_updated, etc.
 */
export async function refreshDashboard(
  reason: RefreshReason
): Promise<DashboardMetrics> {
  console.log(`[dashboardMetrics] refresh triggered: ${reason}`);
  const metrics = await getDashboardMetrics();
  for (const cb of _listeners) {
    try {
      cb(reason, metrics);
    } catch (err) {
      console.error("[dashboardMetrics] listener error:", err);
    }
  }
  return metrics;
}
