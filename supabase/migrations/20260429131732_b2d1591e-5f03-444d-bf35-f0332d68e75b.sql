ALTER TABLE public.gmail_connections
  ADD COLUMN IF NOT EXISTS lookback_seed_completed_at TIMESTAMPTZ;

ALTER TABLE public.mail_accounts
  ADD COLUMN IF NOT EXISTS lookback_seed_completed_at TIMESTAMPTZ;

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS lookback_seed_window_days INTEGER NOT NULL DEFAULT 30
    CHECK (lookback_seed_window_days BETWEEN 1 AND 365);

UPDATE public.gmail_connections
   SET lookback_seed_completed_at = NOW()
 WHERE lookback_seed_completed_at IS NULL;

UPDATE public.mail_accounts
   SET lookback_seed_completed_at = NOW()
 WHERE lookback_seed_completed_at IS NULL;

COMMENT ON COLUMN public.gmail_connections.lookback_seed_completed_at IS
  'Timestamp of the one-shot 30-day lookback scan on first connect. NULL = pending.';
COMMENT ON COLUMN public.mail_accounts.lookback_seed_completed_at IS
  'Timestamp of the one-shot 30-day lookback scan on first connect. NULL = pending.';
COMMENT ON COLUMN public.workspaces.lookback_seed_window_days IS
  'How far back the first-connect lookback scan should look. Default 30 days; configurable per workspace.';