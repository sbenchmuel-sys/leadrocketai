-- 20260430120000_add_score_lead_candidate_cron.sql
--
-- Adds the pg_cron job that drives AI scoring of lead candidates.
-- Runs every 10 minutes via cron-dispatcher → score-lead-candidate edge fn.
-- Scoring is decoupled from detection (every 20 min) so candidates get
-- an ai_score within ~10 min of being inserted.
--
-- ⚠️ HARDCODED KEY: Same anon key as the other 10 dispatcher crons.
-- Rotate all 11 in lockstep when the anon key is regenerated.
-- Tracked in CLAUDE.md → "Open hazards".

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

DO $cleanup$
DECLARE
  jid BIGINT;
BEGIN
  FOR jid IN
    SELECT jobid FROM cron.job
    WHERE jobname = 'dispatch-score-lead-candidate'
  LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END
$cleanup$;

-- Score newly-detected lead candidates every 10 minutes.
SELECT cron.schedule(
  'dispatch-score-lead-candidate',
  '*/10 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "score-lead-candidate"}'::jsonb
  ) AS request_id;
  $cron$
);
