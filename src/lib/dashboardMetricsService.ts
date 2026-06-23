/**
 * Dashboard Metrics Service
 * 
 * Centralised data layer that derives all dashboard KPIs from lead state.
 * UI components consume DashboardMetrics; they never query leads directly.
 */

import { supabase } from "@/integrations/supabase/client";
import { differenceInDays, parseISO } from "date-fns";
import type { EnrichedLead, DealStage, Motion, RevenueState } from "@/lib/dashboardUtils";
import { enrichLead, classifyRevenueState, INTENT_HIDE_FROM_QUEUE } from "@/lib/dashboardUtils";
import { isDemoMode } from "@/lib/demoMode";
import { demoLeads } from "@/lib/demoData";

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

  /** group_id → champion lead id, for stakeholder visibility logic. Empty in demo mode. */
  championByGroup: Record<string, string>;
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
  nurture_mode, nurture_status, eligible_at, automation_mode,
  has_future_meeting, milestones_json, risks_json, ooo_until, action_dismissed_at,
  action_permanently_dismissed, group_id, campaign_id
`;

async function fetchLeads(workspaceId?: string): Promise<EnrichedLead[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  // Lead-visibility scoping: admins see everything RLS permits; every other
  // member (reps AND managers) is restricted to their own leads.
  //
  // The leads SELECT RLS policy is already owner-scoped — is_workspace_admin
  // gates on the workspace 'admin' role only, so a non-admin is DB-restricted
  // to `owner_user_id = self` no matter what the app asks for. This app-level
  // owner filter honestly matches that reality. A genuine manager team-view is
  // parked (see KNOWN_ISSUES.md → "Manager team-view on the Leads page"); do
  // NOT re-add an app-only manager exemption — it's a no-op against RLS.
  //
  // Active-workspace scoping (Codex PR #107): owner-only filtering doesn't
  // constrain to the active workspace, so a member of multiple workspaces who
  // owns leads in each would otherwise see them mixed together. Scope the fetch
  // to the active workspace when it's known.
  //
  // Fail-safe: if the role or active workspace can't be read for any reason,
  // fall back to the most restrictive scope (own leads only). Silence never
  // widens access.
  let query = supabase
    .from("leads")
    .select(DASHBOARD_LEAD_COLUMNS)
    .order("last_activity_at", { ascending: false })
    .limit(1000);

  if (workspaceId) {
    query = query.eq("workspace_id", workspaceId);
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();
  const isAdmin = (profile as { role?: string } | null)?.role === "admin";

  if (!isAdmin) {
    query = query.eq("owner_user_id", user.id);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[dashboardMetrics] fetch error:", error);
    return [];
  }

  return (data || []).map(enrichLead);
}

/**
 * PR C — Build the set of lead IDs whose latest inbound timeline row
 * has an `intent` in `INTENT_HIDE_FROM_QUEUE` (calendar_accept,
 * ooo_reply, bounce, zoom_recap). Used by `classifyRevenueState` to
 * suppress action_required for noise inbounds so the CommandStrip
 * "Action Required" badge stays accurate when the Queue UI (PR D)
 * applies the same hide-rule.
 *
 * Implementation: delegate the per-lead reduction to the
 * `get_latest_intents_for_leads` SECURITY DEFINER RPC
 * (migration 20260521020000). The RPC returns at most one row per
 * input lead via `DISTINCT ON (lead_id)`, so there's no client-side
 * de-duplication and no row cap to worry about. Earlier revisions
 * paginated 5000 rows of inbound timeline items and reduced
 * client-side; that approach silently dropped leads in workspaces
 * with dense inbound history (Codex P2 on PR #44).
 *
 * NULL intent (not yet classified by PR A's cron) is filtered out
 * inside the RPC — callers treat absence as "not hidden", so the UI
 * never depends on async classification.
 */
async function fetchIntentHiddenLeadIds(
  leadIds: string[],
): Promise<Set<string>> {
  if (leadIds.length === 0) return new Set();

  const { data, error } = await supabase.rpc("get_latest_intents_for_leads", {
    p_lead_ids: leadIds,
  });

  if (error) {
    // Non-fatal — fall back to "no hidden ids" so the dashboard renders
    // identical to pre-PR-C behaviour rather than erroring out.
    console.warn("[dashboardMetrics] intent fetch failed:", error.message);
    return new Set();
  }

  const hidden = new Set<string>();
  for (const row of (data ?? []) as Array<{ lead_id: string; intent: string | null }>) {
    if (row.intent && INTENT_HIDE_FROM_QUEUE.has(row.intent)) {
      hidden.add(row.lead_id);
    }
  }
  return hidden;
}

async function fetchChampionByGroup(
  groupIds: string[],
): Promise<Record<string, string>> {
  if (groupIds.length === 0) return {};

  const { data, error } = await supabase
    .from("lead_groups")
    .select("id, champion_lead_id")
    .in("id", groupIds);

  if (error) {
    console.error("[dashboardMetrics] lead_groups fetch error:", error);
    return {};
  }

  const map: Record<string, string> = {};
  for (const row of data || []) {
    if (row.champion_lead_id) map[row.id] = row.champion_lead_id;
  }
  return map;
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

    // Skip OOO leads — an OOO reply is not genuine engagement
    const oooUntil = (lead as any).ooo_until as string | null;
    if (oooUntil && new Date(oooUntil).getTime() > now.getTime()) return false;

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
// DEMO MODE METRICS
// ============================================

function buildDemoMetrics(): DashboardMetrics {
  const leads = demoLeads;
  const openLeads = leads.filter(l => l.stage !== "closed_won" && l.stage !== "closed_lost");

  const revenueStateCounts: Record<RevenueState, number> = {
    active: 0, action_required: 0, heating_up: 0, long_cycle: 0, nurture: 0, automation: 0,
  };
  for (const lead of leads) {
    if (lead.revenueState) revenueStateCounts[lead.revenueState]++;
  }

  return {
    needs_action_count: leads.filter(l => l.needs_action).length,
    active_count: openLeads.length,
    automation_running_count: 0,
    momentum_score: 12,
    stale_count: 0,
    nurture_ready_count: 0,
    warming_up_count: revenueStateCounts.heating_up,
    revenueStateCounts,
    leads,
    staleLeads: [],
    nurtureCandidates: [],
    warmingUpLeads: leads.filter(l => l.revenueState === "heating_up"),
    championByGroup: {},
  };
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Fetch leads and compute all dashboard metrics in one call.
 * `workspaceId`, when provided, scopes the lead fetch to that workspace so a
 * multi-workspace member doesn't see leads they own in OTHER workspaces mixed
 * into the active one (Codex PR #107). Omitting it falls back to owner/RLS
 * scoping.
 */
export async function getDashboardMetrics(
  workspaceId?: string
): Promise<DashboardMetrics> {
  // In demo mode, skip database and use curated dataset
  if (isDemoMode()) {
    return buildDemoMetrics();
  }

  const leads = await fetchLeads(workspaceId);

  const groupIds = Array.from(
    new Set(
      leads
        .map((l) => l.group_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  // PR C — parallel: champion lookup + latest-inbound-intent lookup.
  // Both are independent of the per-lead classify loop below.
  const leadIds = leads.map((l) => l.id);
  const [championByGroup, intentHiddenIds] = await Promise.all([
    fetchChampionByGroup(groupIds),
    fetchIntentHiddenLeadIds(leadIds),
  ]);

  const staleLeads = deriveStaleLeads(leads);
  const nurtureCandidates = deriveNurtureCandidates(leads);
  const warmingUpLeads = deriveWarmingUpLeads(leads);
  const warmingUpIds = new Set(warmingUpLeads.map((l) => l.id));
  const nurtureIds = new Set(nurtureCandidates.map((l) => l.id));

  // Classify every lead into a Revenue State and stamp it
  const openLeads = leads.filter(
    (l) => l.stage !== "closed_won" && l.stage !== "closed_lost"
  );

  const revenueStateCounts: Record<RevenueState, number> = {
    active: 0,
    action_required: 0,
    heating_up: 0,
    long_cycle: 0,
    nurture: 0,
    automation: 0,
  };

  // Counts mirror the tab body's stakeholder-visibility filter so the pill
  // never overstates what the tab can render. Hide non-champion stakeholders
  // from every bucket unless they have unanswered inbound — same rule used by
  // baseFilteredLeads in src/pages/Dashboard.tsx.
  const isVisibleInTab = (l: EnrichedLead): boolean => {
    if (!l.group_id) return true;
    const championId = championByGroup[l.group_id];
    const isStakeholder = !!championId && championId !== l.id;
    if (!isStakeholder) return true;
    if (!l.last_inbound_at) return false;
    const inbound = new Date(l.last_inbound_at).getTime();
    const outbound = l.last_outbound_at ? new Date(l.last_outbound_at).getTime() : 0;
    return inbound > outbound;
  };

  for (const lead of leads) {
    if (lead.stage === "closed_won" || lead.stage === "closed_lost") {
      lead.revenueState = undefined;
      continue;
    }
    const state = classifyRevenueState(lead, warmingUpIds, nurtureIds, intentHiddenIds);
    lead.revenueState = state;
    if (isVisibleInTab(lead)) revenueStateCounts[state]++;
  }

  return {
    needs_action_count: leads.filter((l) => l.needs_action).length,
    active_count: openLeads.length,
    automation_running_count: deriveAutomationRunningCount(leads),
    momentum_score: deriveMomentumScore(leads),
    stale_count: staleLeads.length,
    // Aligned to the new Nurture bucket count so the KPI matches the tab pill.
    // deriveNurtureCandidates() can return more leads than the bucket (e.g. if a
    // candidate is also action_required or long_cycle, the higher-priority bucket
    // wins) — we report what's actually surfaced on the Nurture tab.
    nurture_ready_count: revenueStateCounts.nurture,
    warming_up_count: warmingUpLeads.length,
    revenueStateCounts,
    leads,
    staleLeads,
    nurtureCandidates,
    warmingUpLeads,
    championByGroup,
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
