ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS action_permanently_dismissed boolean
    NOT NULL DEFAULT false;

COMMENT ON COLUMN public.leads.action_permanently_dismissed IS
  'TRUE = user clicked Dismiss on the action_required reminder. Suppresses action_required escalation in dashboardUtils. Cleared by syncEngine on a fresh inbound (same trigger that clears action_dismissed_at).';