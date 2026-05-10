-- 20260510000100_add_calendar_sync_cron.sql
--
-- Adds the pg_cron job that drives calendar awareness (Phase 1).
-- Runs every 15 minutes via cron-dispatcher → calendar-sync edge fn.
--
-- ⚠️ HARDCODED KEY: Same anon key as the other dispatcher crons.
-- Rotate all in lockstep when the anon key is regenerated.
-- Tracked in CLAUDE.md → "Open hazards".

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

-- Idempotent cleanup
DO $cleanup$
DECLARE
  jid BIGINT;
BEGIN
  FOR jid IN
    SELECT jobid FROM cron.job
    WHERE jobname = 'dispatch-calendar-sync'
  LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END
$cleanup$;

-- Pull upcoming Google + Outlook calendar events every 15 minutes.
SELECT cron.schedule(
  'dispatch-calendar-sync',
  '*/15 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "calendar-sync"}'::jsonb
  ) AS request_id;
  $cron$
);
