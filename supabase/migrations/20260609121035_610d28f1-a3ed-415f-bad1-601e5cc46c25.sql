ALTER TABLE public.campaign_enrollment
  ADD COLUMN IF NOT EXISTS bounced_at timestamptz;

COMMENT ON COLUMN public.campaign_enrollment.bounced_at IS
  'Set when this enrolled lead''s cold email bounced (by the existing sync bounce handler). Drives the per-campaign bounce-rate circuit breaker. NULL = no bounce.';

CREATE INDEX IF NOT EXISTS campaign_enrollment_bounced_idx
  ON public.campaign_enrollment (campaign_id) WHERE bounced_at IS NOT NULL;