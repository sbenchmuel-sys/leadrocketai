-- ═══════════════════════════════════════════════════════════════════
-- Keep pg_net's response table lean (2 Nov 2026 slowness incident).
--
-- Every cron-dispatcher call goes through net.http_post (~4,400/day) and pg_net
-- stores each response in net._http_response, deleting rows older than its 6h TTL.
-- Autovacuum never reclaimed those deletes (last_autovacuum was NULL), so the
-- table held ~950 live rows in 290 MB. pg_net's own TTL delete then had to wade
-- through that dead space: it was the #1 consumer of DB time (avg 0.7 s, max
-- 331 s per run, ~1 h/day), and those stalls are what made the app load in 2-8 s
-- bursts and show "Taking longer than usual". Truncated by hand on 2 Nov
-- (290 MB → 32 kB); this job keeps it that way.
--
-- 1. VACUUM net._http_response hourly. pg_cron runs a bare VACUUM fine (it is not
--    wrapped in a transaction); runs as postgres, which can vacuum it (verified).
--    Cheap when the table is small; no exclusive lock.
-- 2. prune_job_logs(): also ANALYZE the two log tables after pruning. Their
--    statistics were stale (planner thought 1.9M rows in job_run_details and
--    seq-scanned 1.2 GB instead of using the runid index).
-- ═══════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
DO $cleanup$
DECLARE jid BIGINT;
BEGIN
  FOR jid IN SELECT jobid FROM cron.job WHERE jobname = 'vacuum-pg-net-responses' LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END
$cleanup$;
SELECT cron.schedule('vacuum-pg-net-responses', '41 * * * *', $$VACUUM (ANALYZE) net._http_response$$);

-- Same body as 20261101090000_scheduler_log_health.sql plus the two ANALYZEs.
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
  ANALYZE public.cron_run_log;
  ANALYZE cron.job_run_details;
  RETURN jsonb_build_object('cron_run_log_deleted', v_run_log, 'job_run_details_deleted', v_details);
END $$;
REVOKE ALL ON FUNCTION public.prune_job_logs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_job_logs(integer) TO service_role;
