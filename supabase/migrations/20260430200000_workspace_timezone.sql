-- 20260430200000_workspace_timezone.sql
--
-- Critical fix for the timezone bug that fired Cliff's 5am ET emails.
--
-- Background:
-- The send-window check (executionSettings.ts.checkSendWindow + isWithinSendWindow)
-- used `date.getHours()` which returns hours in the JS runtime's local timezone.
-- Supabase Edge Functions run in UTC. So a workspace configured for "9am-5pm"
-- actually meant "9am-5pm UTC" for everyone — which is 5am-1pm ET.
--
-- Fix:
-- 1. Add `workspaces.timezone` column (IANA name, e.g. "America/New_York").
-- 2. Server-side checkSendWindow becomes TZ-aware.
-- 3. If a workspace's timezone is NULL, the executor fail-closes — refuses to
--    send anything until the owner explicitly configures their timezone via UI.
--    This is intentional. Better to block than to silently send at the wrong hour.
--
-- Backfill:
-- Cliff's workspace is set to America/New_York explicitly so his automation
-- continues working immediately. Any other workspace remains NULL and is
-- blocked from automated sends until configured. (For pilot stage that's
-- effectively the desired behaviour.)

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS timezone TEXT;

COMMENT ON COLUMN public.workspaces.timezone IS
  'IANA timezone name (e.g. "America/New_York", "Europe/London"). When NULL, automation-executor refuses to send for this workspace until configured. Used by checkSendWindow to compare wall-clock time correctly.';

-- Backfill Cliff's workspace (referenced explicitly in migration 20260430121437
-- as the workspace where 5 emails fired off accidentally).
UPDATE public.workspaces
SET timezone = 'America/New_York'
WHERE id = '9c92f7ce-38f1-49ad-baba-1a7833d6a34b'
  AND timezone IS NULL;
