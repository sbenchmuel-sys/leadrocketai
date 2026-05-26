-- 20260526180100_codify_cron_intelligence_queue_drain.sql
-- Schedule the 5-minute drain of `lead_intelligence_recompute_queue`.
--
-- Companion to:
--   • supabase/migrations/20260526180000_lead_intelligence_recompute_queue.sql
--     (queue table + triggers)
--   • supabase/functions/intelligence-queue-drain/index.ts (the callee)
--   • supabase/functions/cron-dispatcher/index.ts (ALLOWED_TARGETS — must
--     include 'intelligence-queue-drain')
--
-- What it does:
--   Every 5 minutes pg_cron calls cron-dispatcher → intelligence-queue-drain,
--   which pops up to 15 leads from the recompute queue and calls
--   `recompute-lead-intelligence` for each. The queue's PK(lead_id) plus
--   ON CONFLICT DO NOTHING in the source triggers means N signals between
--   ticks = 1 recompute per lead — that's the cost cap.
--
-- ⚠️ HARDCODED KEY: same anon key embedded as all other dispatcher crons
-- (see 20260427230000_codify_cron_jobs.sql). When the anon key rotates this
-- command must be updated in lockstep or the job silently fails. Tracked in
-- CLAUDE.md → "Open hazards".
--
-- Idempotent: re-running this migration unschedules the existing job by
-- jobid and recreates it. Safe.
--
-- AUTHORITATIVE SOURCE: live `cron.job` table. Verify with:
--   SELECT jobid, jobname, schedule, active
--   FROM cron.job
--   WHERE jobname = 'dispatch-intelligence-queue-drain';

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

-- Idempotent cleanup.
DO $cleanup$
DECLARE
  jid BIGINT;
BEGIN
  FOR jid IN
    SELECT jobid FROM cron.job
    WHERE jobname = 'dispatch-intelligence-queue-drain'
  LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END
$cleanup$;

-- Drain the auto-recompute queue. Every 5 minutes.
SELECT cron.schedule(
  'dispatch-intelligence-queue-drain',
  '*/5 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "intelligence-queue-drain"}'::jsonb
  ) AS request_id;
  $cron$
);
