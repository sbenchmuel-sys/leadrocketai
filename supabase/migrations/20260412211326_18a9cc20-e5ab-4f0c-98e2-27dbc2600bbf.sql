
-- Add SMS opt-in flag to leads
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS sms_opted_in boolean NOT NULL DEFAULT false;

-- Add SMS enabled flag and default number to workspaces
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS sms_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_sms_number text;
