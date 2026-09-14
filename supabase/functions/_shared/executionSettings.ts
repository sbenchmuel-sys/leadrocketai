// ============================================
// EXECUTION SETTINGS LOADER
// Loads an owner's cadence/automation settings, scoped to ONE workspace for
// everything the schema actually stores per workspace (currently: timezone).
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
   * IANA timezone for THE workspace passed to loadExecutionSettings (e.g.
   * "America/New_York"), read from workspaces.timezone by id. NULL means that
   * workspace has not configured a timezone (or the id was unknown) —
   * checkSendWindow fails CLOSED in that case. Set in loadExecutionSettings,
   * never derived from cadence_settings.
   */
  timezone: string | null;
  /**
   * OWNER-level pause for ALL automatic sends (legacy + cold). Read from
   * cadence_settings.automation_paused (boolean, default false). The executor
   * skips and logs every due send for this owner while it is true; nothing is
   * deferred, so un-pausing resumes on the next tick. No UI toggle yet — set the
   * key in workspace_profiles.cadence_settings (see CadenceSettingsCard for the
   * natural home of the switch).
   *
   * SCOPE — read this before calling it a "workspace pause": cadence_settings
   * lives on workspace_profiles, which is UNIQUE(user_id) and has NO
   * workspace_id column. One owner has exactly ONE row, so this flag pauses
   * that owner's automatic sends in EVERY workspace they belong to, and there
   * is no way to pause only one workspace. The field is named
   * `owner_automation_paused` so no call site can mistake its blast radius.
   * ponytail: per-workspace scoping needs a schema change (workspace_id on
   * workspace_profiles, or a cadence row keyed by (user_id, workspace_id)) plus
   * a UI toggle — out of scope for Unit G-C; tracked in CLEANUP.md.
   *
   * FAILS CLOSED: if the workspace_profiles read ERRORS we cannot know whether
   * the owner pressed pause, so this is true. "No row" / "no key" is a
   * different thing — that is a genuine "not paused" and stays false.
   */
  owner_automation_paused: boolean;
  /**
   * True when owner_automation_paused is set because the settings read FAILED,
   * not because the owner actually paused. Callers use it only to tell the rep
   * the truth in the skip ledger — both values refuse the send either way.
   */
  settings_read_failed: boolean;
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
  timezone: null,
  owner_automation_paused: false,
  settings_read_failed: false,
};

// ── Loader (cached per owner+workspace within a single executor run) ─

const cache = new Map<string, ExecutionSettings>();

/**
 * Load the send rules for one owner acting in ONE workspace.
 *
 * `workspaceId` is REQUIRED and must be the workspace of the lead being sent to
 * (leads.workspace_id / campaigns.workspace_id). It decides the timezone every
 * send-window and next-eligible calculation runs in. Before Unit G-C this was
 * read from an arbitrary `workspace_members` row, so an owner who belongs to two
 * workspaces had their send window evaluated in whichever timezone happened to
 * come back first — a 9–5 window could fire at 5am for the recipient. An unknown
 * or empty workspaceId yields timezone=null, which checkSendWindow fails CLOSED
 * on, so a bad id refuses the send rather than guessing.
 *
 * Everything else (guardrails, stop rules, the pause) comes from
 * workspace_profiles, which is UNIQUE(user_id) — those values are OWNER-level and
 * identical across the owner's workspaces. See `owner_automation_paused`.
 */
export async function loadExecutionSettings(
  ownerUserId: string,
  serviceClient: ReturnType<typeof createClient>,
  workspaceId: string,
): Promise<ExecutionSettings> {
  const cacheKey = `${ownerUserId}\u0000${workspaceId ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Load owner cadence settings + THIS workspace's timezone in parallel.
  const [profileRes, wsRes] = await Promise.all([
    serviceClient
      .from("workspace_profiles")
      .select("cadence_settings")
      .eq("user_id", ownerUserId)
      .maybeSingle(),
    workspaceId
      ? serviceClient
          .from("workspaces")
          .select("timezone")
          .eq("id", workspaceId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // FAIL CLOSED on a profile READ ERROR (Codex P2). maybeSingle() reports "no
  // such row" as data=null with NO error — that is a real, unpaused owner who
  // has simply never saved cadence settings. An `error` is different: the flag
  // may well be true and we just cannot see it. Defaulting to false there let a
  // transient Postgres/PostgREST blip silently re-arm a paused account, because
  // the timezone read is independent and could still succeed, carrying the run
  // on through the send window. A pause switch must fail toward NOT sending.
  const profileReadFailed = !!(profileRes as any).error;
  if (profileReadFailed) {
    console.error(
      `[executionSettings] workspace_profiles read failed for owner ${ownerUserId} — ` +
      `treating automation as PAUSED (fail closed): ${JSON.stringify((profileRes as any).error)}`,
    );
  }

  // `as any`: workspace_profiles isn't in the Deno-side generated types, so the
  // query builder infers `data` as `never`. Same pattern as the wsRes access below.
  const raw = ((profileRes.data as any)?.cadence_settings as Record<string, unknown>) ?? {};
  const timezone = ((wsRes.data as any)?.timezone as string | null | undefined) ?? null;

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
    // Stored JSON key stays `automation_paused` (production rows already use it);
    // only the in-code name says what it really scopes to. Only a literal boolean
    // true pauses — a string "true" or 1 does not, so a malformed value can never
    // silently stop an owner's sends.
    owner_automation_paused: profileReadFailed || raw.automation_paused === true,
    settings_read_failed: profileReadFailed,
  };

  // A failed read is NOT cached: the blip may be over by the next lead, and
  // caching it would hold a whole run paused on one bad round trip. A real
  // (successful) read is cached for the run as before.
  if (!profileReadFailed) cache.set(cacheKey, settings);
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
 * Email min-gap, measured against the last EMAIL only (Codex P2).
 *
 * `leads.last_outbound_at` is CROSS-CHANNEL: sms-send stamps it (see
 * sms-send/index.ts, the skipStateUpdate branch) and so does the executor's own
 * post-send update, for every channel. Comparing it to
 * `min_gap_hours_between_emails` therefore deferred the next EMAIL as though a
 * text had been an email — which only started happening in the wild once the
 * automatic SMS path became reachable.
 *
 * Cheap by construction: nothing can be more recent than `last_outbound_at`, so
 * when the cross-channel check already ALLOWS the send we return immediately and
 * touch the database not at all. Only when it blocks do we spend one read to ask
 * whether the blocking touch was actually an email.
 *
 * FAILS CLOSED on BOTH unknowns:
 *   - a read ERROR keeps the conservative (blocked) answer;
 *   - an ABSENT mirror row is not evidence of anything, so it is resolved
 *     against the authoritative record rather than assumed to mean "no email".
 * lead_timeline_items is a PROJECTION and a missing mirror row is a supported
 * failure mode in this codebase; `interactions` is the source of truth for
 * outbound email (gmail-send / outlook-send are its sole writers — see the
 * discriminator note below, which is derived from what they actually insert). Treating an
 * absent projection row as "never emailed" let a second email go out inside the
 * minimum gap. Treating it as "blocked" would have been just as wrong the other
 * way — it would hold a lead who really has only ever been texted, which is the
 * cross-channel over-blocking this helper exists to remove. So the two cases are
 * separated by asking the authoritative record, and only when the projection
 * comes back empty.
 *
 * `anchorAt` is the timestamp the decision was made against, so the caller can
 * compute the deferral without re-deriving it.
 */
export async function checkEmailMinGap(
  leadId: string,
  lastOutboundAt: string | null,
  minGapHours: number,
  serviceClient: ReturnType<typeof createClient>,
): Promise<GuardCheckResult & { anchorAt: string | null }> {
  const crossChannel = checkMinGap(lastOutboundAt, minGapHours);
  if (crossChannel.allowed) return { ...crossChannel, anchorAt: lastOutboundAt };

  const { data, error } = await serviceClient
    .from("lead_timeline_items")
    .select("occurred_at")
    .eq("lead_id", leadId)
    .eq("event_type", "email_outbound")
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn(
      `[executionSettings] last-email lookup failed for lead ${leadId} — keeping the ` +
      `cross-channel min-gap block (fail closed): ${JSON.stringify(error)}`,
    );
    return { ...crossChannel, anchorAt: lastOutboundAt };
  }

  const mirroredAt = ((data as any)?.occurred_at as string | null | undefined) ?? null;
  if (mirroredAt) return { ...checkMinGap(mirroredAt, minGapHours), anchorAt: mirroredAt };

  // No mirror row. That is TWO different facts wearing one shape: this lead has
  // never been emailed, or the projection is simply missing the row. Only the
  // first may send. Ask the authoritative record — one extra read, and only on
  // this already-narrow path (the cross-channel check has already blocked AND the
  // projection came back empty).
  //
  // Discriminator — taken from the WRITERS, not from other readers:
  //   gmail-send/index.ts  inserts { type: "email_outbound", ... } and NO direction
  //   outlook-send/index.ts inserts { type: "email_outbound", direction: "outbound" }
  // `direction` is a bare nullable text column (20260106223153_*.sql,
  // `ADD COLUMN IF NOT EXISTS direction text;`) with no default and no backfill,
  // so every row Gmail has ever written has direction NULL. Requiring
  // direction='outbound' therefore matched NONE of them — under SQL's
  // three-valued logic NULL = 'outbound' is NULL, not false — and this lookup
  // silently returned "no email ever", allowing a second email inside the gap.
  // That is the bug this read exists to close, so the predicate must not depend
  // on the column at all for the modern spelling:
  //     type = 'email_outbound'  OR  (type = 'email' AND direction = 'outbound')
  // The value 'email_outbound' already carries the direction. The bare 'email'
  // spelling (older rows) is the only one that needs `direction` to tell an
  // inbound from an outbound, and a NULL there is genuinely ambiguous, so it is
  // correctly excluded rather than guessed at.
  // occurred_at is metadata and survives the 72h body purge, so old rows answer.
  const { data: authoritative, error: authError } = await serviceClient
    .from("interactions")
    .select("occurred_at")
    .eq("lead_id", leadId)
    .or("type.eq.email_outbound,and(type.eq.email,direction.eq.outbound)")
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (authError) {
    console.warn(
      `[executionSettings] authoritative last-email lookup failed for lead ${leadId} — ` +
      `keeping the cross-channel min-gap block (fail closed): ${JSON.stringify(authError)}`,
    );
    return { ...crossChannel, anchorAt: lastOutboundAt };
  }

  // Now the answer is a fact either way: a timestamp means the gap applies from
  // it; null means no outbound email exists in the source of truth, so the lead
  // genuinely has never been emailed and the EMAIL gap is not in play.
  const lastEmailAt = ((authoritative as any)?.occurred_at as string | null | undefined) ?? null;
  return { ...checkMinGap(lastEmailAt, minGapHours), anchorAt: lastEmailAt };
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
