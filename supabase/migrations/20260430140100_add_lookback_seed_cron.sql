-- 20260430140100_add_lookback_seed_cron.sql
--
-- Schedules the one-shot lookback worker (PR #6 of Lead Candidates spec).
-- Runs hourly. Most ticks are no-ops (no accounts pending lookback).
-- When a new mail account connects, the next tick within 60 minutes
-- scans the configured lookback window (default 30 days) and seeds
-- the Pending Leads queue with `source = 'lookback_seed'`.
--
-- ⚠️ HARDCODED KEY: Same anon key as the other 11 dispatcher crons.
-- Rotate all 12 in lockstep. Tracked in CLAUDE.md → "Open hazards".

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

DO $cleanup$
DECLARE
  jid BIGINT;
BEGIN
  FOR jid IN
    SELECT jobid FROM cron.job
    WHERE jobname = 'dispatch-lookback-seed-candidates'
  LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END
$cleanup$;

-- Hourly at :45 (avoid clashes with on-the-hour bursts and the :00/:15/:30 jobs)
SELECT cron.schedule(
  'dispatch-lookback-seed-candidates',
  '45 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "lookback-seed-candidates"}'::jsonb
  ) AS request_id;
  $cron$
);
