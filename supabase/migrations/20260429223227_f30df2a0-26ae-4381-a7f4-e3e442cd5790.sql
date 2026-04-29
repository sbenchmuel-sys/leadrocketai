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

CREATE INDEX IF NOT EXISTS idx_leads_manual_mode
  ON public.leads (manual_mode)
  WHERE manual_mode = true;