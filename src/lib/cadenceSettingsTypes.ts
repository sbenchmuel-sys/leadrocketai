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

export interface SignalRule {
  if: string;
  set_mode?: "fast" | "nurture";
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
  signals: {
    mode_switch_rules: [
      { if: "lead_status=positive", set_mode: "fast" },
      { if: "meeting_scheduled=true", pause: true },
      { if: "open_count>=3", suggest_only: true },
      { if: "link_clicked=true", set_mode: "fast" },
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

// Helper to generate deterministic jitter based on lead_id + action_key
export function getDeterministicJitter(
  leadId: string,
  actionKey: string,
  jitterPercent: number
): number {
  // Simple hash function for determinism
  const hashStr = `${leadId}:${actionKey}`;
  let hash = 0;
  for (let i = 0; i < hashStr.length; i++) {
    const char = hashStr.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  // Normalize to -1 to 1 range, then scale by jitter percent
  const normalized = (hash % 10000) / 10000; // 0 to 1
  return (normalized * 2 - 1) * jitterPercent; // -jitterPercent to +jitterPercent
}

// Helper to check if a time is within the send window (business hours)
export function isWithinSendWindow(
  date: Date,
  timeRules: TimeRules,
  timezone: string | null
): boolean {
  // For now, we use workspace timezone or UTC
  // Convert to local time and check against send window
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
  return day !== 0 && day !== 6; // Not Sunday or Saturday
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
  
  // Apply deterministic jitter
  const jitterMultiplier = getDeterministicJitter(leadId, actionKey, guardrails.jitter_percent);
  const jitteredIntervalMs = intervalMs * (1 + jitterMultiplier);
  
  let eligibleTime = new Date(baseTime + jitteredIntervalMs);
  
  // If using business days and avoiding weekends, adjust forward
  if (time_rules.use_business_days) {
    let iterations = 0;
    const maxIterations = 7; // Prevent infinite loop
    
    while (iterations < maxIterations) {
      if (!isBusinessDay(eligibleTime, time_rules.avoid_weekends)) {
        // Move to next day
        eligibleTime = new Date(eligibleTime.getTime() + 24 * 60 * 60 * 1000);
        // Reset to start of send window
        const [startHour, startMin] = time_rules.send_window_local.start.split(':').map(Number);
        eligibleTime.setHours(startHour, startMin, 0, 0);
        iterations++;
        continue;
      }
      
      if (!isWithinSendWindow(eligibleTime, time_rules, timezone)) {
        // If before window, set to window start
        const [startHour, startMin] = time_rules.send_window_local.start.split(':').map(Number);
        const [endHour, endMin] = time_rules.send_window_local.end.split(':').map(Number);
        const currentHour = eligibleTime.getHours();
        
        if (currentHour < startHour || (currentHour === startHour && eligibleTime.getMinutes() < startMin)) {
          eligibleTime.setHours(startHour, startMin, 0, 0);
        } else if (currentHour >= endHour) {
          // Past window - move to next business day
          eligibleTime = new Date(eligibleTime.getTime() + 24 * 60 * 60 * 1000);
          eligibleTime.setHours(startHour, startMin, 0, 0);
        }
        iterations++;
        continue;
      }
      
      break; // Valid time found
    }
  }
  
  return eligibleTime;
}
