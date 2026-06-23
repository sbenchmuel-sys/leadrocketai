-- ============================================================================
-- 20260623000000_cron_dispatcher_auth_header.sql
--
-- Make every pg_cron job send X-Internal-Secret to cron-dispatcher, so the
-- now-auth-gated dispatcher (Codex P1 on PR #109 — see
-- supabase/functions/cron-dispatcher/index.ts) accepts them. The secret is read
-- AT RUN TIME from the `app.internal_api_secret` database setting, so the real
-- value is never committed to git.
--
-- ⚠️ DEPLOY ORDER MATTERS — getting it wrong silently breaks EVERY cron:
--
--   1. FIRST, set the DB setting to the live value of the INTERNAL_API_SECRET
--      edge-function secret (run once, as a privileged role; not in git):
--
--        ALTER DATABASE postgres
--          SET app.internal_api_secret = '<the INTERNAL_API_SECRET value>';
--
--      (New DB sessions pick this up; pg_cron starts a fresh backend per run.)
--      Verify:  SELECT current_setting('app.internal_api_secret', true) <> '' ;
--
--   2. THEN apply THIS migration — it rewrites the cron jobs to attach the
--      header. (Crons keep working: they now send the secret the dispatcher
--      will require.)
--
--   3. THEN deploy the gated cron-dispatcher (this PR's edge-function change).
--      Once it's live, calls without the secret are rejected.
--
-- If the dispatcher is deployed BEFORE steps 1+2, its forwards' callers (the
-- cron jobs) lack the secret and every dispatch 401s until this is applied.
--
-- This migration is:
--   • Comprehensive — it patches ALL live cron.job rows that post to
--     cron-dispatcher (codified or not), reading the authoritative live list.
--   • Idempotent — jobs that already carry the header are skipped; safe to re-run.
--   • Fail-closed — if the DB setting is unset, the header resolves to null and
--     the dispatcher rejects the call (no silent unauthenticated execution).
--   • Self-reporting — it RAISEs a WARNING for any dispatcher job whose header
--     block didn't match the expected format, so you can patch it by hand.
--
-- Rollback: re-apply the most recent `*_codify_cron_jobs.sql` (which writes the
-- headers without the secret) and revert the dispatcher edge function.
-- ============================================================================

DO $mig$
DECLARE
  j RECORD;
  new_cmd TEXT;
BEGIN
  FOR j IN
    SELECT jobname, schedule, command
    FROM cron.job
    WHERE command ILIKE '%/functions/v1/cron-dispatcher%'
      AND command NOT ILIKE '%X-Internal-Secret%'   -- idempotent: skip already-patched
  LOOP
    -- Wrap the existing `headers := '{...}'::jsonb` literal so it ALSO carries
    -- X-Internal-Secret, evaluated at run time from the DB setting. Nested
    -- dollar-quoting ($re$) keeps the embedded single quotes readable.
    new_cmd := regexp_replace(
      j.command,
      $re$headers\s*:=\s*('[^']*'::jsonb)$re$,
      $re$headers := (\1 || jsonb_build_object('X-Internal-Secret', current_setting('app.internal_api_secret', true)))$re$
    );

    IF new_cmd <> j.command THEN
      PERFORM cron.schedule(j.jobname, j.schedule, new_cmd);
      RAISE NOTICE 'cron-dispatcher-auth: patched job %', j.jobname;
    ELSE
      RAISE WARNING 'cron-dispatcher-auth: job % did not match the expected headers format — patch X-Internal-Secret manually', j.jobname;
    END IF;
  END LOOP;
END
$mig$;
