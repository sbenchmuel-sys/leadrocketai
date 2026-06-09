-- 20260606000100_add_campaign_touch_scheduler_cron.sql
-- Schedule the cold-outreach cadence brain (Outreach Unit C, PR 2).
--
-- Companion to:
--   • supabase/functions/campaign-touch-scheduler/index.ts (the callee)
--   • supabase/functions/cron-dispatcher/index.ts (ALLOWED_TARGETS — updated same PR)
--   • supabase/config.toml ([functions.campaign-touch-scheduler], verify_jwt=false)
--
-- The scheduler surfaces due MANUAL + REVIEW cold touches into the Outreach queue,
-- auto-skips stale/unreachable manual touches, and bridges replies out of the cold
-- cadence. AUTOMATIC email touches are owned by automation-executor (its own cron),
-- not this job. A day-granular cadence does not need minute precision, so this runs
-- every 5 minutes.
--
-- ⚠️ HARDCODED KEY: same anon key as the other dispatcher crons (codified in
-- 20260427230000_codify_cron_jobs.sql). When the anon key rotates, this command
-- must be updated in lockstep with the others or the job silently fails. Tracked
-- in CLAUDE.md → "Open hazards" and KNOWN_ISSUES.md.
--
-- Idempotent: the DO block unschedules any existing job with the same name before
-- scheduling, so re-running this migration is safe.
--
-- AUTHORITATIVE SOURCE: the live `cron.job` table is the source of truth. Verify:
--   SELECT jobid, jobname, schedule, active
--   FROM cron.job WHERE jobname = 'cron_campaign_touch_scheduler';

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

-- Idempotent cleanup: unschedule any existing copy of this job by jobid.
DO $cleanup$
DECLARE
  jid BIGINT;
BEGIN
  FOR jid IN
    SELECT jobid FROM cron.job
    WHERE jobname = 'cron_campaign_touch_scheduler'
  LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END
$cleanup$;

-- Advance the cold cadence every 5 minutes.
SELECT cron.schedule(
  'cron_campaign_touch_scheduler',
  '*/5 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "campaign-touch-scheduler"}'::jsonb
  ) AS request_id;
  $cron$
);
