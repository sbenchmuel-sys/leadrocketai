-- 20260430000000_add_detect_lead_candidates_cron.sql
--
-- Adds the pg_cron job that drives the Lead Candidates detection pipeline.
-- Runs every 20 minutes via cron-dispatcher → detect-lead-candidates edge fn.
--
-- ⚠️ HARDCODED KEY: Same anon key as the other 9 dispatcher crons.
-- Rotate all 10 in lockstep when the anon key is regenerated.
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
    WHERE jobname = 'dispatch-detect-lead-candidates'
  LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END
$cleanup$;

-- Scan all connected mailboxes for new lead candidates every 20 minutes.
SELECT cron.schedule(
  'dispatch-detect-lead-candidates',
  '*/20 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "detect-lead-candidates"}'::jsonb
  ) AS request_id;
  $cron$
);
