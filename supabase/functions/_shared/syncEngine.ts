/**
 * Unified Sync Engine — shared business logic for Gmail and Outlook sync.
 *
 * Extracts all duplicated types, constants, and pure functions so that
 * gmail-sync and outlook-sync stay thin provider-specific wrappers.
 */

// ============================================
// CADENCE SETTINGS TYPES
// ============================================

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
}

export interface StopPauseRules {
  stop_on_any_reply: boolean;
  stop_on_negative_reply: boolean;
  stop_on_unsubscribe: boolean;
  stop_on_bounce: boolean;
  pause_when_meeting_scheduled: boolean;
}

export interface ModeSettings {
  reply_pending_hours: number;
  outbound_followups_days: number[];
  breakup_trigger: {
    days_since_first_outbound: number;
    days_since_last_outbound: number;
  };
  post_meeting: {
    recap_suggest_after_hours: number;
    checkins_days: number[];
  };
}

export interface NurtureCampaignsFlow {
  enabled: boolean;
  cadences_days: { weekly: number; biweekly: number; monthly: number };
  min_days_after_last_touch: number;
}

export interface ReengagementFlow {
  enabled: boolean;
  after_days_no_contact: number;
  sequence_days: number[];
}

export interface PreMeetingFlow {
  enabled: boolean;
  reminder_hours_before: number[];
}

export interface Flows {
  nurture_campaigns: NurtureCampaignsFlow;
  reengagement: ReengagementFlow;
  pre_meeting: PreMeetingFlow;
}

export interface CadenceSettingsV1 {
  version: 1;
  time_rules: TimeRules;
  guardrails: Guardrails;
  stop_pause_rules: StopPauseRules;
  modes: {
    fast: ModeSettings;
    nurture: ModeSettings;
  };
  flows: Flows;
}

export const DEFAULT_CADENCE_SETTINGS: CadenceSettingsV1 = {
  version: 1,
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
  },
  stop_pause_rules: {
    stop_on_any_reply: true,
    stop_on_negative_reply: true,
    stop_on_unsubscribe: true,
    stop_on_bounce: true,
    pause_when_meeting_scheduled: true,
  },
  modes: {
    fast: {
      reply_pending_hours: 4,
      outbound_followups_days: [2, 3, 3, 4],
      breakup_trigger: { days_since_first_outbound: 10, days_since_last_outbound: 5 },
      post_meeting: { recap_suggest_after_hours: 4, checkins_days: [3, 7] },
    },
    nurture: {
      reply_pending_hours: 24,
      outbound_followups_days: [5, 7, 7, 10],
      breakup_trigger: { days_since_first_outbound: 30, days_since_last_outbound: 14 },
      post_meeting: { recap_suggest_after_hours: 24, checkins_days: [7, 14, 30] },
    },
  },
  flows: {
    nurture_campaigns: {
      enabled: true,
      cadences_days: { weekly: 7, biweekly: 14, monthly: 30 },
      min_days_after_last_touch: 7,
    },
    reengagement: {
      enabled: true,
      after_days_no_contact: 45,
      sequence_days: [0, 7],
    },
    pre_meeting: {
      enabled: false,
      reminder_hours_before: [24, 2],
    },
  },
};

// ============================================
// SHARED INTERFACES
// ============================================

export interface LeadMetrics {
  first_outbound_at: string | null;
  last_outbound_at: string | null;
  last_inbound_at: string | null;
  meeting_summary_count: number;
  nurture_outbound_count: number;
  last_nurture_outbound_at: string | null;
}

export type ActionReasonCode =
  | "REPLY_PENDING"
  | "FOLLOWUP_DUE"
  | "BREAKUP_DUE"
  | "NURTURE_DUE"
  | "REENGAGE_DUE"
  | "POST_MEETING_RECAP_DUE"
  | "POST_MEETING_CHECKIN_DUE"
  | "POST_MEETING_FOLLOWUP_DUE"
  | "CLOSING_FOLLOWUP_DUE"
  | "NURTURE_SWITCH_RECOMMENDED"
  | "NURTURE_CAMPAIGN_START"
  | "OOO_RETURN";

export interface ActionResult {
  needs_action: boolean;
  next_action_key: string | null;
  next_action_label: string | null;
  eligible_at: string | null;
  action_reason_code: ActionReasonCode | null;
  auto_nurture_eligible?: boolean;
}

export interface LeadUpdate {
  stage: string;
  needs_action: boolean;
  next_action_key: string | null;
  next_action_label: string | null;
  eligible_at: string | null;
  action_reason_code: string | null;
  first_outbound_at: string | null;
  last_outbound_at: string | null;
  last_inbound_at: string | null;
  meeting_summary_count: number;
  nurture_outbound_count: number;
  last_nurture_outbound_at: string | null;
  last_activity_at?: string;
  action_dismissed_at?: string | null;
  action_permanently_dismissed?: boolean;
  action_resurfaced_at?: string;
  auto_nurture_eligible?: boolean;
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/** Deep merge for cadence settings — arrays are full override. */
export function deepMergeCadence<T extends object>(defaults: T, partial?: Partial<T>): T {
  if (!partial) return defaults;
  const result = { ...defaults };
  for (const key of Object.keys(partial) as (keyof T)[]) {
    const pv = partial[key];
    const dv = defaults[key];
    if (pv === undefined) continue;
    if (Array.isArray(pv)) {
      result[key] = pv as T[keyof T];
    } else if (typeof dv === "object" && dv !== null && !Array.isArray(dv) && typeof pv === "object" && pv !== null) {
      result[key] = deepMergeCadence(dv as object, pv as object) as T[keyof T];
    } else {
      result[key] = pv as T[keyof T];
    }
  }
  return result;
}

/** Deterministic jitter based on lead_id + action_key (no flicker between syncs). */
export function getDeterministicJitter(leadId: string, actionKey: string, jitterPercent: number): number {
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

/** Extract email addresses from a header value (handles "Name" <email> format). */
export function extractEmailAddresses(headerValue: string): string[] {
  const emails: string[] = [];
  const emailRegex = /<([^>]+@[^>]+)>|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  let match;
  while ((match = emailRegex.exec(headerValue)) !== null) {
    const email = (match[1] || match[2]).toLowerCase().trim();
    if (email) emails.push(email);
  }
  return emails;
}

/** Convert HTML to readable plain text. */
export function htmlToPlainText(html: string): string {
  let text = html;
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<\/tr>/gi, "\n");
  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<\/h[1-6]>/gi, "\n\n");
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;/gi, " ");
  text = text.replace(/&amp;/gi, "&");
  text = text.replace(/&lt;/gi, "<");
  text = text.replace(/&gt;/gi, ">");
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  text = text.replace(/&rsquo;/gi, "'");
  text = text.replace(/&lsquo;/gi, "'");
  text = text.replace(/&rdquo;/gi, '"');
  text = text.replace(/&ldquo;/gi, '"');
  text = text.replace(/&mdash;/gi, "—");
  text = text.replace(/&ndash;/gi, "–");
  text = text.replace(/&#\d+;/g, "");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** Negative-intent / lost-deal phrases. If present, the lead is NOT closing. */
export function containsLostIntent(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  const phrases = [
    "no opportunity", "not an opportunity", "don't have an opportunity", "do not have an opportunity",
    "doesn't look like we have an opportunity", "does not look like we have an opportunity",
    "went with another", "went with someone else", "chose another", "selected another vendor",
    "we have decided to go with", "decided to go with another", "going with another",
    "not interested", "no longer interested", "not a fit", "not the right fit",
    "passing on this", "we'll pass", "we will pass", "please remove me", "unsubscribe",
    "keep in touch for potential future", "future opportunities",
    "already have a solution", "already have a vendor", "already partnered",
    "closed with someone else", "signed with another",
  ];
  return phrases.some((p) => t.includes(p));
}

/** Check if email body contains closing-stage keywords (forward-motion only). */
export function containsClosingKeywords(text: string): boolean {
  if (!text) return false;
  // Require explicit forward-motion phrasing — single-word matches like
  // "pricing" or "proposal" appearing in rejection or recap emails caused
  // false-positive "closing" stage promotions.
  const phrases = [
    "send the contract", "sign the contract", "redline", "redlines",
    "security review", "security questionnaire", "vendor onboarding",
    "procurement process", "procurement team", "legal review",
    "send pricing", "send a quote", "send the quote", "approved budget",
    "ready to move forward", "move forward with the proposal",
    "purchase order", "issue a po", "statement of work", "msa",
  ];
  const lowerText = text.toLowerCase();
  if (containsLostIntent(lowerText)) return false;
  return phrases.some((kw) => lowerText.includes(kw));
}

/** Dynamic CORS based on allowed origins. */
export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigins = Deno.env.get("ALLOWED_ORIGINS")?.split(",") || [];
  const isLocalhost = origin.includes("localhost") || origin.includes("127.0.0.1");
  const isLovableProject = origin.endsWith(".lovableproject.com");
  const isLovableApp = origin.endsWith(".lovable.app");
  const isCustomDomain = origin === "https://drivepilot.app" || origin === "https://www.drivepilot.app";
  const isAllowed = allowedOrigins.includes(origin) || isLocalhost || isLovableProject || isLovableApp || isCustomDomain || allowedOrigins.includes("*");
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

// ============================================
// STAGE DERIVATION
// ============================================

export function deriveStage(
  currentStage: string,
  metrics: LeadMetrics,
  hasClosingKeywords: boolean
): string {
  if (currentStage === "closed_won" || currentStage === "closed_lost") return currentStage;
  if (hasClosingKeywords && metrics.last_inbound_at) return "closing";
  if (metrics.meeting_summary_count > 0) return "post_meeting";
  if (metrics.last_inbound_at && metrics.first_outbound_at) {
    if (new Date(metrics.last_inbound_at).getTime() > new Date(metrics.first_outbound_at).getTime()) return "engaged";
  }
  if (metrics.first_outbound_at) return "contacted";
  return "new";
}

// ============================================
// ACTION DERIVATION
// ============================================

export function deriveAction(
  leadId: string,
  metrics: LeadMetrics,
  nurtureCadence: string | null,
  stage: string,
  hasMeetingWithoutFollowup: boolean,
  hasFutureMeeting: boolean,
  recentOutbound7d: number,
  recentOutbound30d: number,
  modeSettings: ModeSettings,
  guardrails: Guardrails,
  stopPauseRules: StopPauseRules,
  flows: Flows,
  timezone: string | null,
  strategy: string,
  motion: string = "outbound_prospecting"
): ActionResult {
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  // STOP/PAUSE RULES
  if (stopPauseRules.pause_when_meeting_scheduled && hasFutureMeeting) {
    return { needs_action: false, next_action_key: "paused_meeting_scheduled", next_action_label: "Paused - meeting scheduled", eligible_at: null, action_reason_code: null };
  }

  // GUARDRAILS
  if (recentOutbound7d >= guardrails.max_emails_per_lead_per_7d) {
    return { needs_action: false, next_action_key: null, next_action_label: null, eligible_at: null, action_reason_code: null };
  }
  if (recentOutbound30d >= guardrails.max_emails_per_lead_per_30d) {
    return { needs_action: false, next_action_key: null, next_action_label: null, eligible_at: null, action_reason_code: null };
  }

  const lastOutTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
  const hoursSinceLastOut = (now - lastOutTime) / HOUR;

  if (hoursSinceLastOut < guardrails.min_gap_hours_between_emails && lastOutTime > 0) {
    const eligibleTime = lastOutTime + (guardrails.min_gap_hours_between_emails * HOUR);
    return { needs_action: false, next_action_key: null, next_action_label: null, eligible_at: new Date(eligibleTime).toISOString(), action_reason_code: null };
  }

  if (!guardrails.same_day_send_allowed && lastOutTime > 0) {
    if (new Date(lastOutTime).toDateString() === new Date(now).toDateString()) {
      return { needs_action: false, next_action_key: null, next_action_label: null, eligible_at: null, action_reason_code: null };
    }
  }

  // A) REPLY PENDING
  if (metrics.last_inbound_at) {
    const inboundTime = new Date(metrics.last_inbound_at).getTime();
    const outboundTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
    if (inboundTime > outboundTime) {
      const elapsed = now - inboundTime;
      const thresholdMs = modeSettings.reply_pending_hours * HOUR;
      if (elapsed > thresholdMs) {
        const jitter = getDeterministicJitter(leadId, "reply_now", guardrails.jitter_percent);
        const eligibleAt = new Date(inboundTime + thresholdMs * (1 + jitter));
        return { needs_action: true, next_action_key: "reply_now", next_action_label: "Reply to customer", eligible_at: eligibleAt.toISOString(), action_reason_code: "REPLY_PENDING" };
      }
    }
  }

  // STOP RULES
  if (stopPauseRules.stop_on_any_reply && metrics.last_inbound_at) {
    const inboundTime = new Date(metrics.last_inbound_at).getTime();
    const outboundTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
    if (inboundTime > outboundTime) {
      return { needs_action: false, next_action_key: "wait_reply_threshold", next_action_label: "Waiting for reply threshold", eligible_at: null, action_reason_code: null };
    }
  }

  // B) CLOSING STAGE
  if (stage === "closing") {
    if (now - lastOutTime > 3 * DAY) {
      const jitter = getDeterministicJitter(leadId, "closing_followup", guardrails.jitter_percent);
      const eligibleAt = new Date(lastOutTime + (3 * DAY) * (1 + jitter));
      return { needs_action: true, next_action_key: "closing_followup", next_action_label: "Follow up on proposal/contract", eligible_at: eligibleAt.toISOString(), action_reason_code: "CLOSING_FOLLOWUP_DUE" };
    }
  }

  // C) PRE-MEETING FOLLOW-UP (skip nurture leads)
  if (motion !== "nurture" && metrics.first_outbound_at && !metrics.last_inbound_at && metrics.meeting_summary_count === 0) {
    const firstOutTime = new Date(metrics.first_outbound_at).getTime();
    const daysSinceFirst = (now - firstOutTime) / DAY;
    const daysSinceLast = (now - lastOutTime) / DAY;
    const breakupTrigger = modeSettings.breakup_trigger;
    const followupDays = modeSettings.outbound_followups_days;

    // NURTURE SWITCH CHECK
    if (strategy === "fast" && daysSinceFirst >= breakupTrigger.days_since_first_outbound * 0.8) {
      let estimatedFollowups = 0;
      let cumDays = 0;
      for (const days of followupDays) {
        cumDays += days;
        if (daysSinceFirst >= cumDays) estimatedFollowups++;
      }
      if (estimatedFollowups >= 3) {
        return { needs_action: true, next_action_key: "switch_to_nurture", next_action_label: "Consider switching to nurture mode", eligible_at: new Date(now).toISOString(), action_reason_code: "NURTURE_SWITCH_RECOMMENDED", auto_nurture_eligible: true };
      }
    }

    // Breakup
    if (daysSinceFirst >= breakupTrigger.days_since_first_outbound && daysSinceLast >= breakupTrigger.days_since_last_outbound) {
      const jitter = getDeterministicJitter(leadId, "send_pre_4", guardrails.jitter_percent);
      const eligibleAt = new Date(lastOutTime + (breakupTrigger.days_since_last_outbound * DAY) * (1 + jitter));
      return { needs_action: true, next_action_key: "send_pre_4", next_action_label: "Send breakup email", eligible_at: eligibleAt.toISOString(), action_reason_code: "BREAKUP_DUE" };
    }

    // Follow-ups
    let cumulativeDays = 0;
    for (let i = 0; i < followupDays.length; i++) {
      cumulativeDays += followupDays[i];
      const nextStepIndex = i + 2;
      if (nextStepIndex > 4) break;
      if (daysSinceFirst >= cumulativeDays && daysSinceLast >= followupDays[i]) {
        const jitter = getDeterministicJitter(leadId, `send_pre_${nextStepIndex}`, guardrails.jitter_percent);
        const eligibleAt = new Date(lastOutTime + (followupDays[i] * DAY) * (1 + jitter));
        return { needs_action: true, next_action_key: `send_pre_${nextStepIndex}`, next_action_label: nextStepIndex === 4 ? "Send breakup email" : `Send follow-up Email ${nextStepIndex}`, eligible_at: eligibleAt.toISOString(), action_reason_code: "FOLLOWUP_DUE" };
      }
    }
  }

  // D) POST-MEETING RECAP
  if (hasMeetingWithoutFollowup) {
    return { needs_action: true, next_action_key: "generate_post_meeting_recap", next_action_label: "Send post-meeting recap", eligible_at: new Date(now).toISOString(), action_reason_code: "POST_MEETING_RECAP_DUE" };
  }

  // D2) POST-MEETING FOLLOW-UP
  if (stage === "post_meeting" && !hasMeetingWithoutFollowup) {
    const lastOutboundTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
    const lastInboundTime = metrics.last_inbound_at ? new Date(metrics.last_inbound_at).getTime() : 0;
    if (lastOutboundTime > 0 && lastOutboundTime > lastInboundTime) {
      const daysSinceOutbound = (now - lastOutboundTime) / DAY;
      if (daysSinceOutbound >= 7) {
        const jitter = getDeterministicJitter(leadId, "post_meeting_followup", guardrails.jitter_percent);
        const eligibleAt = new Date(lastOutboundTime + (7 * DAY) * (1 + jitter));
        return { needs_action: true, next_action_key: "post_meeting_followup", next_action_label: "Follow up (no response in 7 days)", eligible_at: eligibleAt.toISOString(), action_reason_code: "POST_MEETING_FOLLOWUP_DUE" };
      }
    }
  }

  // E) NURTURE
  if (flows.nurture_campaigns.enabled && metrics.nurture_outbound_count > 0 && nurtureCadence) {
    const lastNurtureTime = metrics.last_nurture_outbound_at ? new Date(metrics.last_nurture_outbound_at).getTime() : 0;
    const cadenceDays = flows.nurture_campaigns.cadences_days;
    let intervalDays = cadenceDays.weekly;
    if (nurtureCadence === "biweekly") intervalDays = cadenceDays.biweekly;
    else if (nurtureCadence === "monthly") intervalDays = cadenceDays.monthly;
    if ((now - lastNurtureTime) / DAY >= intervalDays) {
      const jitter = getDeterministicJitter(leadId, `send_nurture_${metrics.nurture_outbound_count + 1}`, guardrails.jitter_percent);
      const eligibleAt = new Date(lastNurtureTime + (intervalDays * DAY) * (1 + jitter));
      return { needs_action: true, next_action_key: `send_nurture_${metrics.nurture_outbound_count + 1}`, next_action_label: "Send nurture email", eligible_at: eligibleAt.toISOString(), action_reason_code: "NURTURE_DUE" };
    }
  }

  // F) RE-ENGAGEMENT
  if (flows.reengagement.enabled) {
    const lastActivityTime = Math.max(
      metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0,
      metrics.last_inbound_at ? new Date(metrics.last_inbound_at).getTime() : 0
    );
    if (lastActivityTime > 0) {
      const daysSinceActivity = (now - lastActivityTime) / DAY;
      if (daysSinceActivity >= flows.reengagement.after_days_no_contact) {
        const jitter = getDeterministicJitter(leadId, "reengage", guardrails.jitter_percent);
        const eligibleAt = new Date(lastActivityTime + (flows.reengagement.after_days_no_contact * DAY) * (1 + jitter));
        return { needs_action: true, next_action_key: "reengage", next_action_label: "Re-engage cold lead", eligible_at: eligibleAt.toISOString(), action_reason_code: "REENGAGE_DUE" };
      }
    }
  }

  return { needs_action: false, next_action_key: null, next_action_label: null, eligible_at: null, action_reason_code: null };
}

// ============================================
// POST-SYNC LEAD UPDATE BUILDER
// ============================================

/**
 * Compute metrics from a list of interactions and build the lead update.
 * Used by both gmail-sync and outlook-sync after message processing.
 */
export function computeMetricsFromInteractions(
  interactions: Array<{ type: string; direction: string | null; occurred_at: string; body_text: string | null }>,
  meetingCount: number
): { metrics: LeadMetrics; hasClosingKeywords: boolean } {
  const metrics: LeadMetrics = {
    first_outbound_at: null,
    last_outbound_at: null,
    last_inbound_at: null,
    meeting_summary_count: meetingCount,
    nurture_outbound_count: 0,
    last_nurture_outbound_at: null,
  };

  let hasClosingKeywords = false;

  for (const interaction of interactions) {
    if (interaction.type === "system_note") continue;
    const dir = interaction.direction || (interaction.type?.includes("inbound") ? "inbound" : "outbound");
    const occurredAt = interaction.occurred_at;
    const bodyLower = (interaction.body_text || "").toLowerCase();

    if (dir === "outbound") {
      if (!metrics.first_outbound_at) metrics.first_outbound_at = occurredAt;
      metrics.last_outbound_at = occurredAt;
      if (bodyLower.includes("nurture") || interaction.type === "nurture_email") {
        metrics.nurture_outbound_count++;
        metrics.last_nurture_outbound_at = occurredAt;
      }
    } else if (dir === "inbound") {
      metrics.last_inbound_at = occurredAt;
      if (containsClosingKeywords(interaction.body_text || "")) hasClosingKeywords = true;
    }
  }

  return { metrics, hasClosingKeywords };
}

/**
 * Build the final LeadUpdate object, handling active automation / nurture / OOO state.
 */
export function buildLeadUpdate(
  stage: string,
  metrics: LeadMetrics,
  actionResult: ActionResult,
  actionDismissedAt: string | null,
  currentLeadState: {
    needs_action: boolean;
    eligible_at: string | null;
    motion: string;
    nurture_status: string;
    ooo_until: string | null;
  } | null,
  // CONSENT GATE: when null, lead has not opted into automation. We will still
  // surface "reply_now" (a manual prompt to the rep) but we will NEVER schedule
  // an outbound send (eligible_at) for this lead. Without this guard, mail sync
  // re-arms the queue every cycle and the executor fires unauthorized sends.
  automationMode: string | null = null,
): LeadUpdate {
  const dismissedAt = actionDismissedAt ? new Date(actionDismissedAt).getTime() : 0;
  // RE-ARM RULE (Phase 2a, HANDOFF-locked): only fresh INBOUND activity
  // clears `action_dismissed_at` / `action_permanently_dismissed`. A rep's
  // own outbound (`last_outbound_at` advancing) used to also re-arm the
  // dismissal via MAX(inbound, outbound) — that yanked just-handled leads
  // back into the queue the moment the rep typed a follow-up. The
  // companion `action_resurfaced_at` stamp below records the clear so the
  // Queue UI can show a "↻ Resurfaced" pill.
  const lastInboundTime = metrics.last_inbound_at ? new Date(metrics.last_inbound_at).getTime() : 0;

  let finalAction = actionResult;
  let shouldClearDismissal = false;

  if (dismissedAt > 0 && dismissedAt > lastInboundTime) {
    finalAction = { needs_action: false, next_action_key: null, next_action_label: null, eligible_at: null, action_reason_code: null, auto_nurture_eligible: actionResult.auto_nurture_eligible };
  } else if (dismissedAt > 0 && lastInboundTime > dismissedAt) {
    shouldClearDismissal = true;
  }

  // CONSENT GATE — strip any scheduled outbound send if the user never opted in.
  // "reply_now" is a UI prompt for the human to reply, not an automated send,
  // so we leave it intact.
  const OUTBOUND_SEND_KEYS = new Set([
    "send_pre_1", "send_pre_2", "send_pre_3", "send_pre_4",
    "send_nurture_1", "send_nurture_2", "send_nurture_3", "send_nurture_4",
    "send_nurture_5", "send_nurture_6", "send_nurture_7", "send_nurture_8",
    "reengage", "closing_followup", "post_meeting_followup",
    "switch_to_nurture", "generate_post_meeting_recap",
  ]);
  if (
    automationMode == null &&
    finalAction.next_action_key &&
    OUTBOUND_SEND_KEYS.has(finalAction.next_action_key)
  ) {
    finalAction = {
      needs_action: false,
      next_action_key: null,
      next_action_label: null,
      eligible_at: null,
      action_reason_code: null,
      auto_nurture_eligible: actionResult.auto_nurture_eligible,
    };
  }

  const hasActiveSequence = currentLeadState?.needs_action === true
    && currentLeadState?.eligible_at
    && new Date(currentLeadState.eligible_at).getTime() > Date.now();
  const hasActiveNurture = currentLeadState?.motion === "nurture" && currentLeadState?.nurture_status === "active";
  const hasActiveOOO = !!currentLeadState?.ooo_until && new Date(currentLeadState.ooo_until).getTime() > Date.now();
  const hasActiveAutomation = hasActiveSequence || hasActiveNurture;

  const leadUpdate: LeadUpdate = {
    stage,
    needs_action: hasActiveAutomation ? currentLeadState!.needs_action : finalAction.needs_action,
    next_action_key: hasActiveAutomation ? null : finalAction.next_action_key,
    next_action_label: hasActiveAutomation ? null : finalAction.next_action_label,
    eligible_at: hasActiveAutomation ? currentLeadState!.eligible_at : finalAction.eligible_at,
    action_reason_code: hasActiveAutomation ? null : finalAction.action_reason_code,
    first_outbound_at: metrics.first_outbound_at,
    last_outbound_at: metrics.last_outbound_at,
    last_inbound_at: hasActiveOOO ? null : metrics.last_inbound_at,
    meeting_summary_count: metrics.meeting_summary_count,
    nurture_outbound_count: metrics.nurture_outbound_count,
    last_nurture_outbound_at: metrics.last_nurture_outbound_at,
  };

  // Derive last_activity_at from the latest real event (inbound or outbound).
  // Never bump to now() on a noop sync — that misleads the dashboard's
  // "Last Activity" column. If no dates are known, omit the field so the
  // DB trigger on lead_timeline_items / the existing value stands.
  const activityDates = [metrics.last_outbound_at, metrics.last_inbound_at]
    .filter(Boolean)
    .map((d) => new Date(d as string).getTime())
    .filter((t) => Number.isFinite(t));
  if (activityDates.length > 0) {
    (leadUpdate as LeadUpdate).last_activity_at = new Date(Math.max(...activityDates)).toISOString();
  }

  // For active nurture/OOO, remove overwrite fields so they're not clobbered
  if (hasActiveNurture || hasActiveOOO) {
    // deno-lint-ignore no-explicit-any
    const u = leadUpdate as any;
    delete u.needs_action;
    delete u.next_action_key;
    delete u.next_action_label;
    delete u.eligible_at;
    delete u.action_reason_code;
    if (hasActiveOOO) delete u.last_inbound_at;
  }

  if (shouldClearDismissal) {
    // CLEAR-CONDITIONS (Phase 2a verified): both `action_dismissed_at` and
    // `action_permanently_dismissed` are cleared together when, and ONLY
    // when, `lastInboundTime > dismissedAt` (i.e. a fresh inbound after
    // the dismissal — rep's own outbounds no longer re-arm the queue per
    // the HANDOFF-locked decision above). `action_resurfaced_at` is
    // stamped in the same UPDATE so the audit trail and the column
    // states stay atomic.
    leadUpdate.action_dismissed_at = null;
    leadUpdate.action_permanently_dismissed = false;
    leadUpdate.action_resurfaced_at = new Date().toISOString();
  }
  if (finalAction.auto_nurture_eligible !== undefined) leadUpdate.auto_nurture_eligible = finalAction.auto_nurture_eligible;

  return leadUpdate;
}
