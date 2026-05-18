-- ============================================================
-- Outlook subscription hardening
--
-- Adds an error_count column so the subscription-check cron can
-- tolerate transient failures (e.g. a 502 BadGateway during the
-- Graph validation handshake) without immediately flipping the
-- mail_account into status='error' and showing a red banner.
--
-- After this migration, subscription-check uses the following policy:
--   - On success: error_count := 0, status := 'active'
--   - On failure: error_count += 1
--   - Only when error_count >= 3 do we escalate to mail_accounts.status='error'
-- ============================================================

ALTER TABLE public.outlook_subscriptions
  ADD COLUMN IF NOT EXISTS error_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.outlook_subscriptions.error_count IS
  'Consecutive renewal/create failures since the last success. Reset to 0 on any successful PATCH/CREATE. Used by outlook-subscription-check to avoid escalating a single transient failure into an account-level error.';
