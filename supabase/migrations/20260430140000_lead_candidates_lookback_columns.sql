-- 20260430140000_lead_candidates_lookback_columns.sql
--
-- Adds the per-account lookback-seed tracking columns required by PR #6
-- of the Lead Candidates pipeline (spec issue #3). One-shot retroactive
-- scan on first mail-account connect.
--
-- - `gmail_connections.lookback_seed_completed_at`
-- - `mail_accounts.lookback_seed_completed_at`
-- - `workspaces.lookback_seed_window_days` (default 30, per spec)
--
-- IMPORTANT: existing rows are backfilled with NOW() so they are NOT
-- re-scanned. Only future connections (where the column starts NULL)
-- will trigger a lookback scan.

ALTER TABLE public.gmail_connections
  ADD COLUMN IF NOT EXISTS lookback_seed_completed_at TIMESTAMPTZ;

ALTER TABLE public.mail_accounts
  ADD COLUMN IF NOT EXISTS lookback_seed_completed_at TIMESTAMPTZ;

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS lookback_seed_window_days INTEGER NOT NULL DEFAULT 30
    CHECK (lookback_seed_window_days BETWEEN 1 AND 365);

-- Backfill existing accounts as already-seeded so the lookback worker
-- does NOT scan months-old mailboxes. New connections start NULL and
-- will be picked up by the worker.
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
