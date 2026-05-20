-- 20260520210100_codify_cron_classify_inbound.sql
-- Schedule the cron job that drives the Phase 2a inbound classifier.
--
-- Companion to:
--   • supabase/functions/classify-inbound/index.ts (the callee)
--   • supabase/functions/cron-dispatcher/index.ts (ALLOWED_TARGETS)
--
-- The classifier picks up `lead_timeline_items` rows where
-- `event_type='email_inbound' AND intent IS NULL` and writes the
-- AI-derived intent + `intent_version='intent_router/v1'`. Runs
-- every 60 seconds (`* * * * *`) so the ~322 legacy NULL rows that
-- Phase 1's heuristic backfill couldn't classify drain in ~13 minutes
-- after deploy.
--
-- ⚠️ HARDCODED KEY: same anon key as the other dispatcher crons
-- (codified in 20260427230000_codify_cron_jobs.sql). When the anon
-- key rotates, this command must be updated in lockstep with the
-- others or the job silently fails. Tracked in
-- CLAUDE.md → "Open hazards" and KNOWN_ISSUES.md.
--
-- Idempotent: the DO block unschedules any existing job with the same
-- name before scheduling, so re-running this migration is safe.
--
-- AUTHORITATIVE SOURCE: the live `cron.job` table is the source of
-- truth. Verify with:
--   SELECT jobid, jobname, schedule, active
--   FROM cron.job
--   WHERE jobname = 'cron_classify_inbound';

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

-- Idempotent cleanup: unschedule any existing copy of this job by jobid.
-- Iterating by jobid avoids the "name does not exist" error that
-- cron.unschedule(name) raises when the job isn't there yet.
DO $cleanup$
DECLARE
  jid BIGINT;
BEGIN
  FOR jid IN
    SELECT jobid FROM cron.job
    WHERE jobname = 'cron_classify_inbound'
  LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END
$cleanup$;

-- Classify the next batch of unclassified inbound emails. Every minute.
SELECT cron.schedule(
  'cron_classify_inbound',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "classify-inbound"}'::jsonb
  ) AS request_id;
  $cron$
);
