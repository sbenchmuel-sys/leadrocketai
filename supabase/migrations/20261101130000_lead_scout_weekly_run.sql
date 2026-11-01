-- 20261101130000_lead_scout_weekly_run.sql
--
-- Lead Scout, Unit 3: the weekly batch + approve-time enrichment.
--   • scout_runs.slot_key + a unique index = the "one weekly batch per profile
--     per workspace-local week" claim. scout-weekly-run INSERTs the kind='weekly'
--     row with slot_key = that week's Monday (YYYY-MM-DD, workspace tz) BEFORE
--     searching; a second overlapping run hits the unique index and skips. A
--     failed attempt renames its key to '<week>:failed:<run id>' so the next
--     hourly run may retry (max 3 per week, enforced in _shared/scoutWeekly.ts).
--     The weekly row's id is the batch id (lead_candidates.scout_batch_id).
--   • scout_runs.resolved_at: set once when a batch has no pending candidates
--     left (conditional UPDATE … WHERE resolved_at IS NULL), so
--     scout_profiles.approved_batches is incremented exactly once per batch.
--   • pg_cron job cron_scout_weekly_run → cron-dispatcher → scout-weekly-run,
--     hourly. The function no-ops unless workspace_automation_settings.scout_enabled
--     and APOLLO_API_KEY are set.
--
-- Re-runnable: IF NOT EXISTS + unschedule-then-schedule.

ALTER TABLE public.scout_runs
  ADD COLUMN IF NOT EXISTS slot_key    TEXT,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_scout_runs_weekly_slot
  ON public.scout_runs (profile_id, slot_key)
  WHERE kind = 'weekly' AND slot_key IS NOT NULL;

COMMENT ON COLUMN public.scout_runs.slot_key IS
  'Lead Scout weekly claim: workspace-local Monday (YYYY-MM-DD) of the batch week; unique per profile for kind=weekly. Failed attempts are renamed <week>:failed:<id>.';
COMMENT ON COLUMN public.scout_runs.resolved_at IS
  'Lead Scout: when this weekly batch had no pending candidates left (approved_batches counted once).';

-- ── Cron ─────────────────────────────────────────────────────────────────────
-- ⚠️ HARDCODED KEY: same anon key as the other dispatcher crons (see CLAUDE.md →
-- "Open hazards"). Rotate in lockstep. Also mirrored in
-- 20260427230000_codify_cron_jobs.sql.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;
DO $cleanup$
DECLARE jid BIGINT;
BEGIN
  FOR jid IN SELECT jobid FROM cron.job WHERE jobname = 'cron_scout_weekly_run' LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END
$cleanup$;
SELECT cron.schedule(
  'cron_scout_weekly_run',
  '5 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := ('{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb || jsonb_build_object('X-Internal-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_api_secret'))),
    body := '{"target": "scout-weekly-run"}'::jsonb
  ) AS request_id;
  $cron$
);
