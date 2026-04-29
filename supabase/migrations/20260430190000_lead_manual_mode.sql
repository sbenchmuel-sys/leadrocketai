-- 20260430190000_lead_manual_mode.sql
--
-- Phase 1 of multi-contact thread support — automation pause flag.
--
-- When an inbound email arrives with multiple participants (To/Cc count > 1),
-- the automation-executor flips the lead into manual_mode = true and stops
-- sending automated cadences. The user takes over via the reply-all UI.
--
-- This is distinct from existing pause signals:
--   - needs_action = false → "nothing to do right now" (transient)
--   - ooo_until → "out of office, resume after date"
--   - manual_mode → "user is in a multi-stakeholder conversation; hands off"
--
-- The lead detail header surfaces this with an "Automation paused" badge
-- linked to the reason text.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS manual_mode BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_mode_reason TEXT,
  ADD COLUMN IF NOT EXISTS manual_mode_set_at TIMESTAMPTZ;

COMMENT ON COLUMN public.leads.manual_mode IS
  'When true, automation-executor skips this lead. Set automatically when an inbound thread becomes multi-participant; can also be set manually.';
COMMENT ON COLUMN public.leads.manual_mode_reason IS
  'Free-text reason shown in the UI tooltip (e.g. "Multi-participant thread").';
COMMENT ON COLUMN public.leads.manual_mode_set_at IS
  'Timestamp when manual_mode was last flipped to true.';

-- Index for fast filtering in automation-executor's eligible-leads query
CREATE INDEX IF NOT EXISTS idx_leads_manual_mode
  ON public.leads (manual_mode)
  WHERE manual_mode = true;
