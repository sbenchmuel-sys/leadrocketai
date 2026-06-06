-- ═══════════════════════════════════════════════════════════════════
-- Outreach Unit C (PR 4) — bounce marker for the aggregate circuit breaker.
--
-- Additive. Reuses the EXISTING per-lead bounce detection (gmail-sync /
-- outlook-sync `isBounce` → leads.unsubscribed) — this is NOT a new bounce list,
-- just a timestamp on the enrollment row that already exists, set in the SAME
-- bounce handler. The scheduler reads it to compute each outreach's aggregate
-- bounce rate and auto-pause a list that's bouncing too hard (protecting the
-- rep's mailbox/domain reputation), logging a volume_alert to cron_run_log.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.campaign_enrollment
  ADD COLUMN IF NOT EXISTS bounced_at timestamptz;

COMMENT ON COLUMN public.campaign_enrollment.bounced_at IS
  'Set when this enrolled lead''s cold email bounced (by the existing sync bounce handler). Drives the per-campaign bounce-rate circuit breaker. NULL = no bounce.';

CREATE INDEX IF NOT EXISTS campaign_enrollment_bounced_idx
  ON public.campaign_enrollment (campaign_id) WHERE bounced_at IS NOT NULL;
