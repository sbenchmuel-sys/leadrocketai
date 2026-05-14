-- 20260513210727_add_transcript_poller_cron.sql
--
-- Adds the pg_cron job that drives Phase 2 meeting-transcript collection.
-- Runs every 15 minutes via cron-dispatcher → transcript-poller edge fn.
-- The poller scans calendar_events with platform IN (...) that ended in the
-- last 24h, dispatches per-meeting fetches (meet-transcript-fetch), and
-- expires stuck transcripts whose meeting ended >24h ago.
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
    WHERE jobname = 'dispatch-transcript-poller'
  LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END
$cleanup$;

-- Scan recently-ended meetings and dispatch transcript fetches every 15 min.
SELECT cron.schedule(
  'dispatch-transcript-poller',
  '*/15 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "transcript-poller"}'::jsonb
  ) AS request_id;
  $cron$
);
