
-- Add nurture mode tracking fields to leads
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS nurture_mode text NOT NULL DEFAULT 'review';
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS nurture_status text NOT NULL DEFAULT 'inactive';
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS nurture_theme text DEFAULT 'balanced';

-- Add comment for documentation
COMMENT ON COLUMN public.leads.nurture_mode IS 'review = manual approve before send, automatic = auto-send at cadence';
COMMENT ON COLUMN public.leads.nurture_status IS 'inactive, active, paused';
COMMENT ON COLUMN public.leads.nurture_theme IS 'balanced, educational, case_study';
