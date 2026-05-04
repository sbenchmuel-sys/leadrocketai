-- 20260504100001_lead_permanent_dismiss.sql
--
-- PR 2.4 — App-wide "permanently dismiss" for action_required reminders.
--
-- Today the X overflow menu in ActionRequiredPanel / PriorityActions only
-- offers Snooze (1/3/7 days), backed by `leads.action_dismissed_at` set to
-- a future timestamp. There is no way to permanently silence the reminder
-- short of waiting for the timer to expire and re-snoozing.
--
-- This column adds a true Dismiss. Cleared by `syncEngine` on a fresh
-- inbound (alongside the existing `action_dismissed_at = null` reset), so
-- when the prospect re-engages the reminder comes back automatically.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS action_permanently_dismissed boolean
    NOT NULL DEFAULT false;

COMMENT ON COLUMN public.leads.action_permanently_dismissed IS
  'TRUE = user clicked Dismiss on the action_required reminder. Suppresses '
  'action_required escalation in dashboardUtils. Cleared by syncEngine on '
  'a fresh inbound (same trigger that clears action_dismissed_at).';
