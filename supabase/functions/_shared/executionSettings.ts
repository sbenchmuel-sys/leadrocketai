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
  /**
   * IANA timezone for this workspace (e.g. "America/New_York"). Loaded from
   * workspaces.timezone via workspace_members join. NULL means the workspace
   * has not configured a timezone — checkSendWindow will fail-closed in that
   * case. Set in loadExecutionSettings, never derived from cadence_settings.
   */
  timezone: string | null;
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

  // Load cadence settings + workspace timezone in parallel.
  // Timezone lives on workspaces (NOT workspace_profiles) so we join via
  // workspace_members. A user may belong to multiple workspaces; we take
  // the first match — automation runs per-owner, so a single owner's
  // sends are gated by whichever workspace they happen to belong to.
  const [profileRes, wsRes] = await Promise.all([
    serviceClient
      .from("workspace_profiles")
      .select("cadence_settings")
      .eq("user_id", ownerUserId)
      .maybeSingle(),
    serviceClient
      .from("workspace_members")
      .select("workspace_id, workspaces:workspace_id (timezone)")
      .eq("user_id", ownerUserId)
      .limit(1)
      .maybeSingle(),
  ]);

  const raw = (profileRes.data?.cadence_settings as Record<string, unknown>) ?? {};
  const timezone =
    ((wsRes.data as any)?.workspaces?.timezone as string | null | undefined) ?? null;

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
    timezone: timezone && timezone.trim() ? timezone.trim() : null,
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

// ── Timezone-aware time helpers ────────────────────────────────────
//
// CRITICAL: Edge Functions run in UTC. Date.prototype.getHours/getDay return
// runtime-local values, so they are silently UTC. We must explicitly project
// to the workspace's IANA timezone before comparing wall-clock times.
//
// All helpers below treat an invalid/unknown timezone as a fatal misconfig:
// the caller (checkSendWindow) fail-closes when timezone is null. Helpers
// receiving a non-null but invalid string will throw RangeError from Intl,
// which propagates up and is caught by the executor as an error skip.

interface TzWallClock {
  hour: number;
  minute: number;
  weekday: number; // 0 = Sun, 6 = Sat (matches Date.prototype.getDay)
  year: number;
  month: number;  // 0-indexed (matches Date.prototype.getMonth)
  day: number;
}

function getWallClockInTz(date: Date, timeZone: string): TzWallClock {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";

  // Intl returns "24" for midnight in some locales; normalize to 0.
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0;

  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };

  return {
    hour,
    minute: parseInt(get("minute"), 10),
    weekday: weekdayMap[get("weekday")] ?? 0,
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10) - 1,
    day: parseInt(get("day"), 10),
  };
}

/**
 * Construct a UTC Date that represents `hour:minute` wall-clock on the given
 * Y-M-D in the target timezone. Used by computeNextEligibleAt to snap forward.
 *
 * Approach: build a "naive UTC" timestamp treating the wall-clock components
 * as if UTC, then subtract the timezone's offset at that approximate instant.
 * Handles DST correctly because the offset is computed at the target moment.
 */
function utcInstantForTzWallclock(
  year: number,
  monthIdx: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naiveUtcMs = Date.UTC(year, monthIdx, day, hour, minute, 0, 0);
  // Iterate twice to converge on DST boundaries (offset depends on the instant).
  let offsetMs = tzOffsetMsAt(new Date(naiveUtcMs), timeZone);
  let candidate = naiveUtcMs - offsetMs;
  offsetMs = tzOffsetMsAt(new Date(candidate), timeZone);
  return new Date(naiveUtcMs - offsetMs);
}

/** Offset (ms) the timezone is ahead of UTC at the given instant. NY in DST → -14400000. */
function tzOffsetMsAt(date: Date, timeZone: string): number {
  // Trick: format the date as a fake-UTC ISO string for both target TZ and UTC,
  // then subtract. Both use the same parser so DST is consistent.
  const tzWall = getWallClockInTz(date, timeZone);
  const tzAsIfUtc = Date.UTC(
    tzWall.year, tzWall.month, tzWall.day,
    tzWall.hour, tzWall.minute, 0, 0,
  );
  return tzAsIfUtc - date.getTime();
}

/** Check if date falls on a business day, in the given timezone. */
export function isBusinessDay(date: Date, avoidWeekends: boolean, timeZone: string): boolean {
  if (!avoidWeekends) return true;
  const { weekday } = getWallClockInTz(date, timeZone);
  return weekday !== 0 && weekday !== 6;
}

/** Check if time is within the send window, in the given timezone. */
export function isWithinSendWindow(
  date: Date,
  sendWindow: { start: string; end: string },
  timeZone: string,
): boolean {
  const { hour, minute } = getWallClockInTz(date, timeZone);
  const timeStr = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
  return timeStr >= sendWindow.start && timeStr <= sendWindow.end;
}

/**
 * Compute eligible_at for the next step, respecting:
 * - delay_days (from campaign_steps or legacy intervals)
 * - jitter_percent
 * - send_window_local (in workspace timezone)
 * - avoid_weekends / use_business_days (in workspace timezone)
 *
 * If the workspace has no timezone configured, falls back to scheduling at
 * the raw delayed time. checkSendWindow will then refuse the send when the
 * cron actually fires, so safety is preserved — the schedule just isn't
 * snapped to business hours until the workspace is configured.
 */
export function computeNextEligibleAt(
  delayDays: number,
  leadId: string,
  actionKey: string,
  settings: ExecutionSettings,
): Date {
  const { time_rules, guardrails, timezone } = settings;

  // Apply jitter to delay
  const jitter = getDeterministicJitter(leadId, actionKey, guardrails.jitter_percent);
  const jitteredDelayMs = delayDays * 86_400_000 * (1 + jitter);
  let eligibleTime = new Date(Date.now() + jitteredDelayMs);

  // Without a timezone we can't snap to wall-clock business hours — return
  // the delayed time as-is. checkSendWindow will fail-closed at send time.
  if (!timezone) return eligibleTime;

  const [startHour, startMin] = time_rules.send_window_local.start.split(":").map(Number);
  const [endHour] = time_rules.send_window_local.end.split(":").map(Number);

  let iterations = 0;
  const maxIterations = 14; // safety: never loop more than 2 weeks

  try {
    while (iterations < maxIterations) {
      const wall = getWallClockInTz(eligibleTime, timezone);

      // Weekend → advance to next day at start-of-window in target TZ
      if (time_rules.use_business_days && time_rules.avoid_weekends && (wall.weekday === 0 || wall.weekday === 6)) {
        eligibleTime = utcInstantForTzWallclock(wall.year, wall.month, wall.day + 1, startHour, startMin, timezone);
        iterations++;
        continue;
      }

      // Before window → snap to start of same day in target TZ
      if (wall.hour < startHour || (wall.hour === startHour && wall.minute < startMin)) {
        eligibleTime = utcInstantForTzWallclock(wall.year, wall.month, wall.day, startHour, startMin, timezone);
        break;
      }

      // After window → next day at start in target TZ
      if (wall.hour >= endHour) {
        eligibleTime = utcInstantForTzWallclock(wall.year, wall.month, wall.day + 1, startHour, startMin, timezone);
        iterations++;
        continue;
      }

      // Within window → good
      break;
    }
  } catch (err) {
    // Invalid timezone string somehow leaked through — return raw delayed time.
    // checkSendWindow will reject it at send time.
    console.warn(`[executionSettings] computeNextEligibleAt TZ error (${timezone}): ${err instanceof Error ? err.message : String(err)}`);
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
 *
 * FAIL-CLOSED: if the workspace has no configured timezone, refuse the send.
 * This prevents the previous bug where missing timezone silently defaulted to
 * UTC, causing 5am ET sends to slip through a "9-5" window.
 */
export function checkSendWindow(settings: ExecutionSettings): GuardCheckResult {
  if (!settings.timezone) {
    return {
      allowed: false,
      reason: "Workspace timezone not configured — set it in Settings before automation can run",
    };
  }

  const now = new Date();
  const { time_rules } = settings;

  // Defensive: if Intl rejects the timezone string (typo/deprecated), bail.
  try {
    if (time_rules.use_business_days && !isBusinessDay(now, time_rules.avoid_weekends, settings.timezone)) {
      return {
        allowed: false,
        reason: `Weekend in ${settings.timezone}: ${now.toISOString()} — avoid_weekends is on`,
      };
    }

    if (!isWithinSendWindow(now, time_rules.send_window_local, settings.timezone)) {
      return {
        allowed: false,
        reason: `Outside send window ${time_rules.send_window_local.start}–${time_rules.send_window_local.end} ${settings.timezone}`,
      };
    }
  } catch (err) {
    return {
      allowed: false,
      reason: `Invalid timezone "${settings.timezone}": ${err instanceof Error ? err.message : String(err)}`,
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
