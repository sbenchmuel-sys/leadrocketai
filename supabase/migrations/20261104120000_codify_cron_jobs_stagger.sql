-- ============================================================================
-- 20261104120000_codify_cron_jobs_stagger.sql
--
-- DB load reduction, Phase 0 (plan: db-load-upgrade-plan-2026-11-04):
--   1. Every pg_cron job that calls net.http_post gets
--      timeout_milliseconds := 58000. Without it pg_net uses its 5 s default,
--      the response is dropped, and ~6–8 % of cron_run_log rows stay 'running'.
--   2. Stagger the schedules so at most a few jobs share a minute (up to 11
--      fired in the same second at :00). Slow the two no-op pollers
--      (whatsapp: 0 messages in 30 d; classify-inbound: ~5 emails/day) and
--      manager-analytics (46 s/run) until Unit C makes it cheap.
--   3. prune_job_logs(): cron_run_log retention 14 → 7 days.
--
-- WHY THIS PATCHES LIVE ROWS INSTEAD OF DELETE-AND-RECREATE:
-- the last prod codify file (20260427230000_codify_cron_jobs.sql) is from April.
-- Recreating jobs from it would drop the X-Internal-Secret Vault header added by
-- 20260623000000_cron_dispatcher_auth_header.sql (every dispatch would 401). It
-- also misses about 10 jobs added later, one of them (classify-outbound-every-5min)
-- created only in the dashboard and in no migration. The live cron.job table is
-- the truth (CLAUDE.md), so this migration edits it in place, like 20260623 does:
--   • cron.alter_job(jobid, schedule / command). It uses only the cron.* API and
--     never writes to cron.job directly.
--   • Jobs are found BY NAME. No job is renamed, created or dropped. active
--     flags are untouched (call-media-purge stays off; staging's executor stays
--     off).
--   • URL, headers and body of every command are kept byte-for-byte. Only
--     `timeout_milliseconds := 58000,` is inserted as the first named argument.
--     The anon key is STILL hardcoded in the prod commands (CLAUDE.md → Open
--     hazards).
--   • Idempotent: jobs that already have a timeout are skipped, and setting a
--     schedule to the same value is a no-op. Safe to re-run.
--   • Environment-agnostic: it touches no URL or key, so the same file is
--     correct on staging. No separate _staging copy is needed. Caveat: re-running
--     20260908000000_codify_cron_jobs_staging.sql on staging restores the old
--     schedules with no timeouts. Re-apply this file afterwards.
--   • A missing job name or a command that doesn't match RAISEs a WARNING; it
--     does not fail.
--
-- Verify after apply:
--   SELECT jobname, schedule, active FROM cron.job ORDER BY schedule;
--   SELECT jobname FROM cron.job
--    WHERE command ILIKE '%net.http_post%' AND command NOT ILIKE '%timeout_milliseconds%';  -- 0 rows
-- ============================================================================

DO $mig$
DECLARE
  s RECORD;
  j RECORD;
  found_job BOOLEAN;
  new_cmd TEXT;
BEGIN
  -- ── 1. Schedules (only the jobs whose schedule changes) ────────────────────
  FOR s IN
    SELECT * FROM (VALUES
      ('dispatch-whatsapp-events',          '*/10 * * * *'),
      ('cron_classify_inbound',             '*/5 * * * *'),
      ('classify-outbound-every-5min',      '3,18,33,48 * * * *'),
      ('cron_campaign_touch_scheduler',     '6,21,36,51 * * * *'),
      ('dispatch-intelligence-queue-drain', '9,24,39,54 * * * *'),
      ('dispatch-automation-executor',      '1,16,31,46 * * * *'),
      ('dispatch-calendar-sync',            '4,19,34,49 * * * *'),
      ('dispatch-transcript-poller',        '7,22,37,52 * * * *'),
      ('cron_pilot_reports',                '11,41 * * * *'),
      ('dispatch-score-lead-candidate',     '2,12,22,32,42,52 * * * *'),
      ('dispatch-detect-lead-candidates',   '13,33,53 * * * *'),
      ('dispatch-gmail-bulk-sync',          '8,28,48 * * * *'),
      -- ponytail: every 4h while it costs 46 s/run; back to hourly after Unit C
      -- (SQL aggregate) lands, in a later codify migration.
      ('dispatch-manager-analytics',        '23 */4 * * *')
    ) v(jobname, schedule)
  LOOP
    found_job := false;
    FOR j IN SELECT jobid FROM cron.job WHERE jobname = s.jobname LOOP
      PERFORM cron.alter_job(j.jobid, schedule := s.schedule);
      found_job := true;
    END LOOP;
    IF NOT found_job THEN
      RAISE WARNING 'cron-stagger: job % not found, schedule not changed', s.jobname;
    END IF;
  END LOOP;

  -- ── 2. pg_net timeout on every net.http_post job ───────────────────────────
  FOR j IN
    SELECT jobid, jobname, command FROM cron.job
    WHERE command ILIKE '%net.http_post%'
      AND command NOT ILIKE '%timeout_milliseconds%'   -- idempotent
  LOOP
    -- Named notation, so argument order doesn't matter. The match requires
    -- `url :=` to come first, so a call with positional arguments is never
    -- rewritten into invalid SQL (it gets the WARNING below instead).
    new_cmd := regexp_replace(
      j.command,
      $re$net\.http_post\((\s*)(url\s*:=)$re$,
      $re$net.http_post(\1timeout_milliseconds := 58000,\1\2$re$,
      'g'
    );
    IF new_cmd <> j.command THEN
      PERFORM cron.alter_job(j.jobid, command := new_cmd);
    ELSE
      RAISE WARNING 'cron-stagger: job % calls net.http_post in an unexpected form — add timeout_milliseconds by hand', j.jobname;
    END IF;
  END LOOP;
END
$mig$;

-- ── 3. Log retention: cron_run_log 14 → 7 days (job_run_details stays 7) ────
-- Same body as 20261101090000_scheduler_log_health.sql; only the interval changes.
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
                   WHERE started_at < now() - interval '7 days' LIMIT _batch);
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
