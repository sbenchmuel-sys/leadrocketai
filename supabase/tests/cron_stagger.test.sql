-- ═══════════════════════════════════════════════════════════════════
-- Checks for 20261104120000_codify_cron_jobs_stagger.sql against the cron.job
-- stub in fixture_schema.sql: seed jobs in their pre-stagger shape (prod literal
-- headers, prod Vault-wrapped headers, staging Vault URL, plain SQL), re-apply
-- the migration (also proves re-runs are safe), then assert:
--   (a) every net.http_post command carries timeout_milliseconds := 58000 and is
--       otherwise byte-for-byte unchanged;
--   (b) no two active jobs share a bare */N minute field;
--   plus the new schedules, untouched active flags, and 7-day log retention.
-- ═══════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on

INSERT INTO cron.job (jobname, schedule, command, active)
SELECT name, sched,
       CASE kind
         WHEN 'prod' THEN format($c$
  SELECT net.http_post(
    url := 'https://example.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"target": "%s"}'::jsonb
  ) AS request_id;
  $c$, name)
         WHEN 'vault' THEN format($c$
  SELECT net.http_post(
    url := 'https://example.supabase.co/functions/v1/cron-dispatcher',
    headers := ('{"Content-Type": "application/json"}'::jsonb || jsonb_build_object('X-Internal-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_api_secret'))),
    body := '{"target": "%s"}'::jsonb
  ) AS request_id;
  $c$, name)
         WHEN 'staging' THEN format($c$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_functions_url') || '/cron-dispatcher',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{"target": "%s"}'::jsonb
    ) AS request_id;
    $c$, name)
         ELSE 'SELECT public.' || replace(name, '-', '_') || '()'
       END,
       active
FROM (VALUES
  ('dispatch-whatsapp-events',            '* * * * *',    'prod',    true),
  ('cron_classify_inbound',               '* * * * *',    'vault',   true),
  ('classify-outbound-every-5min',        '*/5 * * * *',  'vault',   true),
  ('cron_campaign_touch_scheduler',       '*/15 * * * *', 'vault',   true),
  ('dispatch-intelligence-queue-drain',   '*/15 * * * *', 'vault',   true),
  ('dispatch-automation-executor',        '*/15 * * * *', 'staging', false),
  ('dispatch-calendar-sync',              '*/15 * * * *', 'vault',   true),
  ('dispatch-transcript-poller',          '*/15 * * * *', 'vault',   true),
  ('cron_pilot_reports',                  '*/15 * * * *', 'vault',   true),
  ('dispatch-score-lead-candidate',       '*/10 * * * *', 'vault',   true),
  ('dispatch-detect-lead-candidates',     '*/20 * * * *', 'vault',   true),
  ('dispatch-gmail-bulk-sync',            '*/20 * * * *', 'vault',   true),
  ('dispatch-manager-analytics',          '0 * * * *',    'vault',   true),
  ('dispatch-reply-suggestions',          '30 * * * *',   'vault',   true),
  ('dispatch-lookback-seed-candidates',   '45 * * * *',   'vault',   true),
  ('dispatch-promote-winning',            '0 */6 * * *',  'vault',   true),
  ('dispatch-outlook-subscription-check', '0 */12 * * *', 'vault',   true),
  ('dispatch-nurture-pre-generate',       '0 8 * * *',    'vault',   true),
  ('vacuum-pg-net-responses',             '41 * * * *',   'sql',     true),
  ('prune-job-logs',                      '17 3 * * *',   'sql',     true),
  ('call-media-purge',                    '30 3 * * *',   'sql',     false)
) v(name, sched, kind, active);

CREATE TEMP TABLE before_jobs AS SELECT * FROM cron.job;

\i supabase/migrations/20261104120000_codify_cron_jobs_stagger.sql
CREATE TEMP TABLE after_first AS SELECT * FROM cron.job;
\i supabase/migrations/20261104120000_codify_cron_jobs_stagger.sql

DO $t$
DECLARE n int; d int;
BEGIN
  -- re-run is a no-op
  SELECT count(*) INTO n FROM cron.job j JOIN after_first a USING (jobid)
   WHERE (j.schedule, j.command, j.active) IS DISTINCT FROM (a.schedule, a.command, a.active);
  IF n <> 0 THEN RAISE EXCEPTION 'second apply changed % jobs', n; END IF;

  -- (a) every http_post job has the timeout …
  SELECT count(*) INTO n FROM cron.job
   WHERE command LIKE '%net.http_post%' AND command NOT LIKE '%timeout_milliseconds := 58000%';
  IF n <> 0 THEN RAISE EXCEPTION '% net.http_post jobs lack timeout_milliseconds := 58000', n; END IF;
  -- … and nothing else in the command changed (url/headers/body intact)
  SELECT count(*) INTO n FROM cron.job j JOIN before_jobs b USING (jobid)
   WHERE regexp_replace(j.command, 'timeout_milliseconds := 58000,\s*', '') <> b.command;
  IF n <> 0 THEN RAISE EXCEPTION '% commands changed beyond the timeout insert', n; END IF;
  SELECT count(*) INTO n FROM cron.job WHERE command LIKE '%timeout_milliseconds := 58000%';
  IF n <> 18 THEN RAISE EXCEPTION 'expected 18 patched http jobs, got %', n; END IF;

  -- (b) no two active jobs share a bare */N minute field
  SELECT count(*), count(DISTINCT split_part(schedule, ' ', 1)) INTO n, d
    FROM cron.job WHERE active AND split_part(schedule, ' ', 1) LIKE '*/%';
  IF d < n THEN RAISE EXCEPTION '% active */N jobs share only % minute fields', n, d; END IF;

  -- schedules: changed ones moved, unchanged ones kept
  SELECT count(*) INTO n FROM cron.job WHERE (jobname, schedule) IN (
    ('dispatch-whatsapp-events','*/10 * * * *'), ('cron_classify_inbound','*/5 * * * *'),
    ('dispatch-gmail-bulk-sync','8,28,48 * * * *'), ('dispatch-manager-analytics','23 */4 * * *'),
    ('dispatch-automation-executor','1,16,31,46 * * * *'), ('dispatch-promote-winning','0 */6 * * *'),
    ('call-media-purge','30 3 * * *'));
  IF n <> 7 THEN RAISE EXCEPTION 'schedule spot-check: % of 7 match', n; END IF;

  -- active flags untouched (staging executor + call-media-purge stay off)
  SELECT count(*) INTO n FROM cron.job j JOIN before_jobs b USING (jobid) WHERE j.active <> b.active;
  IF n <> 0 THEN RAISE EXCEPTION '% active flags changed', n; END IF;
  IF (SELECT active FROM cron.job WHERE jobname = 'call-media-purge') THEN
    RAISE EXCEPTION 'call-media-purge was activated';
  END IF;
END $t$;

-- prune_job_logs keeps 7 days of cron_run_log
INSERT INTO public.cron_run_log (started_at) VALUES (now() - interval '8 days'), (now() - interval '6 days');
SELECT public.prune_job_logs();
DO $t$
BEGIN
  IF (SELECT count(*) FROM public.cron_run_log) <> 1
     OR EXISTS (SELECT 1 FROM public.cron_run_log WHERE started_at < now() - interval '7 days') THEN
    RAISE EXCEPTION 'prune_job_logs did not apply 7-day cron_run_log retention';
  END IF;
END $t$;
