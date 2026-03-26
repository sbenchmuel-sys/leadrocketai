// ============================================
// EXECUTION SETTINGS LOADER
// Loads workspace cadence/automation settings for the executor.
// Single source of truth for all "when/whether to send" rules.
// ============================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Types (mirrors CadenceSettingsV1 from client) ──────────────────

export interface TimeRules {
  timezone_mode: "workspace" | "lead";
  use_business_days: boolean;
  send_window_local: { start: string; end: string };
  avoid_weekends: boolean;
}

export interface Guardrails {
  min_gap_hours_between_emails: number;
  max_emails_per_lead_per_7d: number;
  max_emails_per_lead_per_30d: number;
  same_day_send_allowed: boolean;
  jitter_percent: number;
  max_sends_per_day_per_mailbox: number;
}

export interface StopPauseRules {
  stop_on_any_reply: boolean;
  stop_on_negative_reply: boolean;
  stop_on_unsubscribe: boolean;
  stop_on_bounce: boolean;
  pause_when_meeting_scheduled: boolean;
}

export interface WhatsAppExecutionSettings {
  automation_enabled: boolean;
  max_messages_before_pause: number;
}

export interface ExecutionSettings {
  time_rules: TimeRules;
  guardrails: Guardrails;
  stop_pause_rules: StopPauseRules;
  whatsapp: WhatsAppExecutionSettings;
}

// ── Defaults (match DEFAULT_CADENCE_SETTINGS) ──────────────────────

const DEFAULT_EXECUTION_SETTINGS: ExecutionSettings = {
  time_rules: {
    timezone_mode: "workspace",
    use_business_days: true,
    send_window_local: { start: "09:00", end: "17:00" },
    avoid_weekends: true,
  },
  guardrails: {
    min_gap_hours_between_emails: 16,
    max_emails_per_lead_per_7d: 3,
    max_emails_per_lead_per_30d: 8,
    same_day_send_allowed: false,
    jitter_percent: 0.15,
    max_sends_per_day_per_mailbox: 40,
  },
  stop_pause_rules: {
    stop_on_any_reply: true,
    stop_on_negative_reply: true,
    stop_on_unsubscribe: true,
    stop_on_bounce: true,
    pause_when_meeting_scheduled: true,
  },
  whatsapp: {
    automation_enabled: false,
    max_messages_before_pause: 3,
  },
};

// ── Loader (cached per-owner within a single executor run) ─────────

const cache = new Map<string, ExecutionSettings>();

export async function loadExecutionSettings(
  ownerUserId: string,
  serviceClient: ReturnType<typeof createClient>,
): Promise<ExecutionSettings> {
  const cached = cache.get(ownerUserId);
  if (cached) return cached;

  const { data: wpProfile } = await serviceClient
    .from("workspace_profiles")
    .select("cadence_settings")
    .eq("user_id", ownerUserId)
    .maybeSingle();

  const raw = (wpProfile?.cadence_settings as Record<string, unknown>) ?? {};

  const settings: ExecutionSettings = {
    time_rules: {
      ...DEFAULT_EXECUTION_SETTINGS.time_rules,
      ...(raw.time_rules as Record<string, unknown> || {}),
      send_window_local: {
        ...DEFAULT_EXECUTION_SETTINGS.time_rules.send_window_local,
        ...((raw.time_rules as any)?.send_window_local || {}),
      },
    },
    guardrails: {
      ...DEFAULT_EXECUTION_SETTINGS.guardrails,
      ...(raw.guardrails as Record<string, unknown> || {}),
    },
    stop_pause_rules: {
      ...DEFAULT_EXECUTION_SETTINGS.stop_pause_rules,
      ...(raw.stop_pause_rules as Record<string, unknown> || {}),
    },
    whatsapp: {
      ...DEFAULT_EXECUTION_SETTINGS.whatsapp,
      ...(raw.whatsapp as Record<string, unknown> || {}),
    },
  };

  cache.set(ownerUserId, settings);
  return settings;
}

/** Clear cache between executor invocations (called at start of serve) */
export function clearSettingsCache(): void {
  cache.clear();
}

// ── Timing helpers ─────────────────────────────────────────────────

/** Deterministic jitter based on leadId + actionKey */
export function getDeterministicJitter(
  leadId: string,
  actionKey: string,
  jitterPercent: number,
): number {
  const hashStr = `${leadId}:${actionKey}`;
  let hash = 0;
  for (let i = 0; i < hashStr.length; i++) {
    const char = hashStr.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const normalized = (hash % 10000) / 10000;
  return (normalized * 2 - 1) * jitterPercent;
}

/** Check if date falls on a business day */
export function isBusinessDay(date: Date, avoidWeekends: boolean): boolean {
  if (!avoidWeekends) return true;
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

/** Check if time is within the send window */
export function isWithinSendWindow(
  date: Date,
  sendWindow: { start: string; end: string },
): boolean {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const timeStr = `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
  return timeStr >= sendWindow.start && timeStr <= sendWindow.end;
}

/**
 * Compute eligible_at for the next step, respecting:
 * - delay_days (from campaign_steps or legacy intervals)
 * - jitter_percent
 * - send_window_local
 * - avoid_weekends / use_business_days
 */
export function computeNextEligibleAt(
  delayDays: number,
  leadId: string,
  actionKey: string,
  settings: ExecutionSettings,
): Date {
  const { time_rules, guardrails } = settings;

  // Apply jitter to delay
  const jitter = getDeterministicJitter(leadId, actionKey, guardrails.jitter_percent);
  const jitteredDelayMs = delayDays * 86_400_000 * (1 + jitter);
  let eligibleTime = new Date(Date.now() + jitteredDelayMs);

  // Parse send window start
  const [startHour, startMin] = time_rules.send_window_local.start.split(":").map(Number);
  const [endHour] = time_rules.send_window_local.end.split(":").map(Number);

  // Snap to send window + business day
  let iterations = 0;
  const maxIterations = 14; // safety: never loop more than 2 weeks

  while (iterations < maxIterations) {
    // Skip weekends
    if (time_rules.use_business_days && !isBusinessDay(eligibleTime, time_rules.avoid_weekends)) {
      eligibleTime = new Date(eligibleTime.getTime() + 86_400_000);
      eligibleTime.setHours(startHour, startMin, 0, 0);
      iterations++;
      continue;
    }

    // Before send window → snap to start
    const currentHour = eligibleTime.getHours();
    const currentMin = eligibleTime.getMinutes();
    if (currentHour < startHour || (currentHour === startHour && currentMin < startMin)) {
      eligibleTime.setHours(startHour, startMin, 0, 0);
      break;
    }

    // After send window → next day at start
    if (currentHour >= endHour) {
      eligibleTime = new Date(eligibleTime.getTime() + 86_400_000);
      eligibleTime.setHours(startHour, startMin, 0, 0);
      iterations++;
      continue;
    }

    // Within window → good
    break;
  }

  return eligibleTime;
}

// ── Guard checks ───────────────────────────────────────────────────

export interface GuardCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check min_gap_hours_between_emails against last outbound time
 */
export function checkMinGap(
  lastOutboundAt: string | null,
  minGapHours: number,
): GuardCheckResult {
  if (!lastOutboundAt) return { allowed: true };
  const lastSendMs = new Date(lastOutboundAt).getTime();
  const gapMs = Date.now() - lastSendMs;
  const gapHours = gapMs / (1000 * 60 * 60);
  if (gapHours < minGapHours) {
    return {
      allowed: false,
      reason: `Min gap not met: ${gapHours.toFixed(1)}h < ${minGapHours}h`,
    };
  }
  return { allowed: true };
}

/**
 * Check per-lead send caps (7d and 30d)
 */
export async function checkPerLeadCaps(
  leadId: string,
  guardrails: Guardrails,
  serviceClient: ReturnType<typeof createClient>,
): Promise<GuardCheckResult> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();

  // 7-day cap
  const { count: count7d } = await serviceClient
    .from("automation_log")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .eq("status", "sent")
    .gte("created_at", sevenDaysAgo);

  if ((count7d ?? 0) >= guardrails.max_emails_per_lead_per_7d) {
    return {
      allowed: false,
      reason: `Per-lead 7d cap: ${count7d}/${guardrails.max_emails_per_lead_per_7d}`,
    };
  }

  // 30-day cap
  const { count: count30d } = await serviceClient
    .from("automation_log")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .eq("status", "sent")
    .gte("created_at", thirtyDaysAgo);

  if ((count30d ?? 0) >= guardrails.max_emails_per_lead_per_30d) {
    return {
      allowed: false,
      reason: `Per-lead 30d cap: ${count30d}/${guardrails.max_emails_per_lead_per_30d}`,
    };
  }

  return { allowed: true };
}

/**
 * Check send window: is "now" within the configured send window on a business day?
 */
export function checkSendWindow(settings: ExecutionSettings): GuardCheckResult {
  const now = new Date();
  const { time_rules } = settings;

  if (time_rules.use_business_days && !isBusinessDay(now, time_rules.avoid_weekends)) {
    return {
      allowed: false,
      reason: `Weekend: ${now.toISOString()} — avoid_weekends is on`,
    };
  }

  if (!isWithinSendWindow(now, time_rules.send_window_local)) {
    return {
      allowed: false,
      reason: `Outside send window: ${time_rules.send_window_local.start}–${time_rules.send_window_local.end}`,
    };
  }

  return { allowed: true };
}

/**
 * Evaluate stop conditions against lead state.
 * Returns { allowed: false, reason } if automation should stop.
 */
export function checkStopConditions(
  stopRules: StopPauseRules,
  leadState: {
    has_reply: boolean;
    has_meeting: boolean;
    is_unsubscribed: boolean;
  },
): GuardCheckResult {
  if (stopRules.stop_on_any_reply && leadState.has_reply) {
    return { allowed: false, reason: "Stop: lead replied (stop_on_any_reply)" };
  }
  if (stopRules.pause_when_meeting_scheduled && leadState.has_meeting) {
    return { allowed: false, reason: "Pause: meeting scheduled (pause_when_meeting_scheduled)" };
  }
  if (stopRules.stop_on_unsubscribe && leadState.is_unsubscribed) {
    return { allowed: false, reason: "Stop: lead unsubscribed (stop_on_unsubscribe)" };
  }
  return { allowed: true };
}

// ── Delay resolver ─────────────────────────────────────────────────

/**
 * Resolve the delay in days for the next step.
 * Priority:
 *   1. Structured campaign step delay_days
 *   2. Legacy email_intervals_days from cadence settings
 *   3. Hardcoded fallback (2 days)
 */
export function resolveStepDelay(
  nextStepNumber: number,
  structuredCampaignSteps: Array<{ step_number: number; delay_days: number; active: boolean }> | null,
  legacyIntervals: number[] | null,
): number {
  // Priority 1: structured campaign step
  if (structuredCampaignSteps) {
    const step = structuredCampaignSteps.find(s => s.step_number === nextStepNumber && s.active);
    if (step) return step.delay_days;
  }

  // Priority 2: legacy cumulative intervals → convert to gap
  if (legacyIntervals && legacyIntervals.length >= nextStepNumber) {
    const stepIdx = nextStepNumber - 1;
    if (stepIdx > 0) {
      return legacyIntervals[stepIdx] - legacyIntervals[stepIdx - 1];
    }
    return legacyIntervals[0] || 0;
  }

  // Fallback
  return 2;
}
