-- Add cadence_settings JSONB column to workspace_profiles
ALTER TABLE workspace_profiles
ADD COLUMN IF NOT EXISTS cadence_settings JSONB NOT NULL DEFAULT '{
  "version": 1,
  "time_rules": {
    "timezone_mode": "workspace",
    "use_business_days": true,
    "send_window_local": { "start": "09:00", "end": "17:00" },
    "avoid_weekends": true
  },
  "guardrails": {
    "min_gap_hours_between_emails": 16,
    "max_emails_per_lead_per_7d": 3,
    "max_emails_per_lead_per_30d": 8,
    "same_day_send_allowed": false,
    "jitter_percent": 0.15
  },
  "stop_pause_rules": {
    "stop_on_any_reply": true,
    "stop_on_negative_reply": true,
    "stop_on_unsubscribe": true,
    "stop_on_bounce": true,
    "pause_when_meeting_scheduled": true
  },
  "modes": {
    "fast": {
      "reply_pending_hours": 4,
      "outbound_followups_days": [2, 3, 3, 4],
      "breakup_trigger": { "days_since_first_outbound": 10, "days_since_last_outbound": 5 },
      "post_meeting": { "recap_suggest_after_hours": 4, "checkins_days": [3, 7] }
    },
    "nurture": {
      "reply_pending_hours": 24,
      "outbound_followups_days": [5, 7, 7, 10],
      "breakup_trigger": { "days_since_first_outbound": 30, "days_since_last_outbound": 14 },
      "post_meeting": { "recap_suggest_after_hours": 24, "checkins_days": [7, 14, 30] }
    }
  },
  "flows": {
    "nurture_campaigns": {
      "enabled": true,
      "cadences_days": { "weekly": 7, "biweekly": 14, "monthly": 30 },
      "min_days_after_last_touch": 7
    },
    "reengagement": {
      "enabled": true,
      "after_days_no_contact": 45,
      "sequence_days": [0, 7]
    },
    "pre_meeting": {
      "enabled": false,
      "reminder_hours_before": [24, 2]
    }
  },
  "signals": {
    "mode_switch_rules": [
      { "if": "lead_status=positive", "set_mode": "fast" },
      { "if": "meeting_scheduled=true", "pause": true },
      { "if": "open_count>=3", "suggest_only": true },
      { "if": "link_clicked=true", "set_mode": "fast" }
    ]
  }
}'::jsonb;

-- Add eligible_at and action_reason_code columns to leads for automation-ready infrastructure
ALTER TABLE leads
ADD COLUMN IF NOT EXISTS eligible_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

ALTER TABLE leads
ADD COLUMN IF NOT EXISTS action_reason_code TEXT DEFAULT NULL;

-- Add has_future_meeting column to leads for proper meeting scheduled detection
ALTER TABLE leads
ADD COLUMN IF NOT EXISTS has_future_meeting BOOLEAN NOT NULL DEFAULT false;

-- Create index on eligible_at for efficient querying of pending actions
CREATE INDEX IF NOT EXISTS idx_leads_eligible_at ON leads (eligible_at) WHERE eligible_at IS NOT NULL;

-- Create index on action_reason_code for filtering by action type
CREATE INDEX IF NOT EXISTS idx_leads_action_reason_code ON leads (action_reason_code) WHERE action_reason_code IS NOT NULL;