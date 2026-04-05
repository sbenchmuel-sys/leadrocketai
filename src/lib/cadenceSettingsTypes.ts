// ============================================
// CADENCE SETTINGS TYPES (v1)
// Single source of truth for all cadence-related configuration
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
  max_sends_per_day_per_mailbox: number;
}

export interface StopPauseRules {
  stop_on_any_reply: boolean;
  stop_on_negative_reply: boolean;
  stop_on_unsubscribe: boolean;
  stop_on_bounce: boolean;
  pause_when_meeting_scheduled: boolean;
}

// Motion-based interval types (replaces ModeSettings)
export interface MotionIntervals {
  email_intervals_days: number[];
}

export interface NurtureIntervals {
  cadences: { weekly: number; biweekly: number; monthly: number };
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

export interface SignalRule {
  if: string;
  set_motion?: "outbound" | "inbound" | "nurture";
  pause?: boolean;
  suggest_only?: boolean;
}

export interface AutoNurtureSettings {
  enabled: boolean;
  after_followup_count: number;
  auto_switch_after_breakup: boolean;
  default_cadence: "weekly" | "biweekly" | "monthly";
}

export interface Signals {
  mode_switch_rules: SignalRule[];
  auto_nurture?: AutoNurtureSettings;
}

export interface WhatsAppCadenceSettings {
  outbound_followups_hours: number[];
  nurture_cadence_days: number[];
  post_meeting_hours: number[];
  max_messages_before_pause: number;
  automation_enabled: boolean;
}

export const DEFAULT_WHATSAPP_CADENCE: WhatsAppCadenceSettings = {
  outbound_followups_hours: [24, 48, 72],
  nurture_cadence_days: [7, 14],
  post_meeting_hours: [4, 48],
  max_messages_before_pause: 3,
  automation_enabled: false,
};

export interface CadenceSettingsV1 {
  version: 1;
  time_rules: TimeRules;
  guardrails: Guardrails;
  stop_pause_rules: StopPauseRules;
  motions: {
    outbound: MotionIntervals;
    inbound: MotionIntervals;
    nurture: NurtureIntervals;
  };
  whatsapp: WhatsAppCadenceSettings;
  flows: Flows;
  signals: Signals;
}

// Default settings (single source of truth)
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
    max_sends_per_day_per_mailbox: 40,
  },
  stop_pause_rules: {
    stop_on_any_reply: true,
    stop_on_negative_reply: true,
    stop_on_unsubscribe: true,
    stop_on_bounce: true,
    pause_when_meeting_scheduled: true,
  },
  motions: {
    outbound: {
      email_intervals_days: [0, 2, 4, 7],
    },
    inbound: {
      email_intervals_days: [0, 2, 4],
    },
    nurture: {
      cadences: { weekly: 7, biweekly: 14, monthly: 30 },
    },
  },
  whatsapp: { ...DEFAULT_WHATSAPP_CADENCE },
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
  signals: {
    mode_switch_rules: [
      { if: "lead_status=positive", set_motion: "outbound" },
      { if: "meeting_scheduled=true", pause: true },
      { if: "open_count>=3", suggest_only: true },
      { if: "link_clicked=true", set_motion: "outbound" },
    ],
    auto_nurture: {
      enabled: true,
      after_followup_count: 3,
      auto_switch_after_breakup: false,
      default_cadence: "biweekly",
    },
  },
};

// Deep merge helper for backwards compatibility
// Arrays are treated as full override (no deep merge)
export function deepMergeCadenceSettings<T extends object>(
  defaults: T,
  partial?: Partial<T>
): T {
  if (!partial) return defaults;
  
  const result = { ...defaults };
  for (const key of Object.keys(partial) as (keyof T)[]) {
    const partialValue = partial[key];
    const defaultValue = defaults[key];
    
    if (partialValue === undefined) continue;
    
    // Arrays are treated as full override
    if (Array.isArray(partialValue)) {
      result[key] = partialValue as T[keyof T];
    }
    // Objects (but not arrays) are deep merged
    else if (
      typeof defaultValue === 'object' &&
      defaultValue !== null &&
      !Array.isArray(defaultValue) &&
      typeof partialValue === 'object' &&
      partialValue !== null
    ) {
      result[key] = deepMergeCadenceSettings(
        defaultValue as object,
        partialValue as object
      ) as T[keyof T];
    }
    // Primitives are directly assigned
    else {
      result[key] = partialValue as T[keyof T];
    }
  }
  return result;
}

// Action reason codes for automation-ready infrastructure
export type ActionReasonCode =
  | "REPLY_PENDING"
  | "FOLLOWUP_DUE"
  | "BREAKUP_DUE"
  | "NURTURE_DUE"
  | "REENGAGE_DUE"
  | "POST_MEETING_RECAP_DUE"
  | "POST_MEETING_CHECKIN_DUE"
  | "CLOSING_FOLLOWUP_DUE"
  | "PRE_MEETING_REMINDER_DUE"
  | "NURTURE_SWITCH_RECOMMENDED"
  | "NURTURE_CAMPAIGN_START";

// Extended action result with eligibility for automation
export interface ActionSuggestion {
  needs_action: boolean;
  next_action_key: string | null;
  next_action_label: string | null;
  eligible_at: string | null; // ISO timestamp when action becomes due
  reason_code: ActionReasonCode | null;
}

// Helper to get motion intervals for outbound/inbound
export function getMotionIntervals(motion: string): number[] {
  const defaults = DEFAULT_CADENCE_SETTINGS.motions;
  if (motion === "outbound_prospecting") return defaults.outbound.email_intervals_days;
  if (motion === "inbound_response") return defaults.inbound.email_intervals_days;
  return defaults.outbound.email_intervals_days; // fallback
}

// Helper to get nurture cadence interval in days
export function getNurtureCadenceDays(cadence: string): number {
  const cadences = DEFAULT_CADENCE_SETTINGS.motions.nurture.cadences;
  switch (cadence) {
    case "weekly": return cadences.weekly;
    case "monthly": return cadences.monthly;
    case "biweekly":
    default: return cadences.biweekly;
  }
}

// Helper to generate deterministic jitter based on lead_id + action_key
export function getDeterministicJitter(
  leadId: string,
  actionKey: string,
  jitterPercent: number
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

// Stagger a send time across a business-day window (default 9:00–16:30)
// Uses a deterministic hash from leadId so each lead gets a stable slot
export function staggerSendTime(
  date: Date,
  leadId: string,
  windowStart = 9,
  windowEnd = 16.5
): Date {
  let hash = 0;
  for (let i = 0; i < leadId.length; i++) {
    hash = ((hash << 5) - hash) + leadId.charCodeAt(i);
    hash = hash & hash;
  }
  const bucket = ((hash >>> 0) % 10000) / 10000; // 0-1
  const totalMinutes = (windowEnd - windowStart) * 60; // e.g. 450 min
  const offsetMinutes = Math.floor(bucket * totalMinutes);
  const hour = windowStart + Math.floor(offsetMinutes / 60);
  const minute = offsetMinutes % 60;
  const result = new Date(date);
  result.setHours(Math.floor(hour), minute, 0, 0);
  return result;
}

// Helper to check if a time is within the send window (business hours)
export function isWithinSendWindow(
  date: Date,
  timeRules: TimeRules,
  timezone: string | null
): boolean {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
  
  return timeStr >= timeRules.send_window_local.start && 
         timeStr <= timeRules.send_window_local.end;
}

// Helper to check if a date is a business day
export function isBusinessDay(date: Date, avoidWeekends: boolean): boolean {
  if (!avoidWeekends) return true;
  const day = date.getDay();
  return day !== 0 && day !== 6;
}

// Calculate next eligible time respecting time rules
export function calculateEligibleAt(
  baseTime: number,
  intervalMs: number,
  leadId: string,
  actionKey: string,
  cadenceSettings: CadenceSettingsV1,
  timezone: string | null
): Date {
  const { time_rules, guardrails } = cadenceSettings;
  
  const jitterMultiplier = getDeterministicJitter(leadId, actionKey, guardrails.jitter_percent);
  const jitteredIntervalMs = intervalMs * (1 + jitterMultiplier);
  
  let eligibleTime = new Date(baseTime + jitteredIntervalMs);
  
  if (time_rules.use_business_days) {
    let iterations = 0;
    const maxIterations = 7;
    
    while (iterations < maxIterations) {
      if (!isBusinessDay(eligibleTime, time_rules.avoid_weekends)) {
        eligibleTime = new Date(eligibleTime.getTime() + 24 * 60 * 60 * 1000);
        const [startHour, startMin] = time_rules.send_window_local.start.split(':').map(Number);
        eligibleTime.setHours(startHour, startMin, 0, 0);
        iterations++;
        continue;
      }
      
      if (!isWithinSendWindow(eligibleTime, time_rules, timezone)) {
        const [startHour, startMin] = time_rules.send_window_local.start.split(':').map(Number);
        const [endHour, endMin] = time_rules.send_window_local.end.split(':').map(Number);
        const currentHour = eligibleTime.getHours();
        
        if (currentHour < startHour || (currentHour === startHour && eligibleTime.getMinutes() < startMin)) {
          eligibleTime.setHours(startHour, startMin, 0, 0);
        } else if (currentHour >= endHour) {
          eligibleTime = new Date(eligibleTime.getTime() + 24 * 60 * 60 * 1000);
          eligibleTime.setHours(startHour, startMin, 0, 0);
        }
        iterations++;
        continue;
      }
      
      break;
    }
  }
  
  return eligibleTime;
}
