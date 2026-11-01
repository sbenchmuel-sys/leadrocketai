-- ═══════════════════════════════════════════════════════════════════
-- Scheduler log health (pre-pilot fix, 1 Nov 2026).
--
-- Since 30 Oct ~30% of cron-dispatcher runs stay 'running' forever and pg_cron
-- skips runs. Root cause: cron-dispatcher records each run's completion with
--   UPDATE cron_run_log ... WHERE request_id = $1
-- and request_id had NO index, so every completion (~3/min) seq-scanned the whole
-- table (724k rows, 227 MB, ~0.6 s cold even on an idle DB). Under load these
-- pile up and time out. Meanwhile the logs nobody prunes (cron_run_log 227 MB,
-- cron.job_run_details 1.2 GB) are ~15x the real data and push it out of cache,
-- which is the general slowness / API timeouts.
--
-- 1. Index request_id (the completion lookup becomes a single-row index hit).
-- 2. prune_job_logs(): keep 14 days of cron_run_log and 7 days of
--    cron.job_run_details. message-cleanup also prunes cron_run_log (30 days),
--    but that job is deliberately unscheduled until the retention decision, so
--    log pruning gets its own job here, independent of that decision.
--    Deletes in bounded batches so a run never holds long locks.
-- 3. Run it daily at 03:17 UTC. Plain SQL, no secrets.
-- ═══════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_cron_run_log_request_id ON public.cron_run_log (request_id);

CREATE OR REPLACE FUNCTION public.prune_job_logs(_batch integer DEFAULT 50000)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run_log bigint := 0;
  v_details bigint := 0;
  n bigint;
BEGIN
  LOOP
    DELETE FROM public.cron_run_log
     WHERE id IN (SELECT id FROM public.cron_run_log
                   WHERE started_at < now() - interval '14 days' LIMIT _batch);
    GET DIAGNOSTICS n = ROW_COUNT;
    v_run_log := v_run_log + n;
    EXIT WHEN n < _batch;
  END LOOP;
  LOOP
    DELETE FROM cron.job_run_details
     WHERE runid IN (SELECT runid FROM cron.job_run_details
                      WHERE end_time < now() - interval '7 days' LIMIT _batch);
    GET DIAGNOSTICS n = ROW_COUNT;
    v_details := v_details + n;
    EXIT WHEN n < _batch;
  END LOOP;
  RETURN jsonb_build_object('cron_run_log_deleted', v_run_log, 'job_run_details_deleted', v_details);
END $$;
REVOKE ALL ON FUNCTION public.prune_job_logs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_job_logs(integer) TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
DO $cleanup$
DECLARE jid BIGINT;
BEGIN
  FOR jid IN SELECT jobid FROM cron.job WHERE jobname = 'prune-job-logs' LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END
$cleanup$;
SELECT cron.schedule('prune-job-logs', '17 3 * * *', $$SELECT public.prune_job_logs()$$);
