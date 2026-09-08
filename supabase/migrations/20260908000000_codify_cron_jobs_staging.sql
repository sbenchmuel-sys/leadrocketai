-- 20260908000000_codify_cron_jobs_staging.sql
-- STAGING ONLY — never apply to production.
--
-- Staging mirror of 20260427230000_codify_cron_jobs.sql (same 10 dispatcher
-- jobs, same schedules, same bodies). Differences, all deliberate:
--   • The functions URL and the anon key are NOT literals. They are read at run
--     time from Supabase Vault: secrets named 'staging_functions_url'
--     (e.g. https://<staging-ref>.supabase.co/functions/v1) and
--     'staging_anon_key'. Nothing in this file names a project, so it cannot
--     point a staging cron at production even if applied to the wrong DB.
--   • X-Internal-Secret is attached from the 'internal_api_secret' Vault secret,
--     as 20260623000000_cron_dispatcher_auth_header.sql does for prod — the
--     staging cron-dispatcher is auth-gated and would 401 without it.
--   • dispatch-automation-executor is created but immediately set active=false,
--     which is how staging runs today (Eligible Ed has full-auto consent; an
--     active job would send real email). Enable it only by hand, only on purpose.
--
-- Safety on the wrong database: the whole body is skipped (RAISE NOTICE, no
-- changes) unless BOTH staging Vault secrets exist. Production has neither, so
-- a `supabase db push` that sweeps this file into prod is a no-op there —
-- prod's live crons are untouched.
--
-- One-time setup (run once on STAGING, values never go in git):
--   SELECT vault.create_secret('https://<staging-ref>.supabase.co/functions/v1', 'staging_functions_url');
--   SELECT vault.create_secret('<staging anon key>', 'staging_anon_key');
--   SELECT vault.create_secret('<staging INTERNAL_API_SECRET>', 'internal_api_secret');
-- Verify:
--   SELECT name FROM vault.decrypted_secrets
--    WHERE name IN ('staging_functions_url','staging_anon_key','internal_api_secret');
--
-- Fail-closed at run time: if 'internal_api_secret' is missing the header is
-- NULL and the dispatcher rejects the call; no unauthenticated work runs.
--
-- Idempotent: unschedules the named jobs and recreates them. Apply with
--   supabase db push --project-ref jhipmqdpjenojfhfjgzq
-- (never without --project-ref: supabase/config.toml points at production).
-- Guarded by src/test/noProdRefInStagingSql.test.ts (no prod ref in this file).

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

DO $mig$
DECLARE
  jid BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'staging_functions_url')
     OR NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'staging_anon_key') THEN
    RAISE NOTICE 'codify_cron_jobs_staging: Vault secrets staging_functions_url / staging_anon_key not found — this is not the staging database (or they are not created yet). Skipping; no cron jobs changed.';
    RETURN;
  END IF;

  -- ── Idempotent cleanup: unschedule existing jobs by name ───────────────────
  FOR jid IN
    SELECT jobid FROM cron.job
    WHERE jobname = ANY(ARRAY[
      'dispatch-automation-executor',
      'dispatch-nurture-pre-generate',
      'dispatch-outlook-subscription-check',
      'dispatch-gmail-bulk-sync',
      'dispatch-whatsapp-events',
      'dispatch-promote-winning',
      'dispatch-message-cleanup',
      'dispatch-reply-suggestions',
      'dispatch-manager-analytics',
      'dispatch-calendar-sync'
    ])
  LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;

  -- ── Schedule the dispatcher jobs (URL / key / secret from Vault) ───────────

  -- Send queued automation drips. Every 15 minutes; the executor itself filters
  -- by per-workspace local-time send windows.
  PERFORM cron.schedule(
    'dispatch-automation-executor',
    '*/15 * * * *',
    $cron$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_functions_url') || '/cron-dispatcher',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_anon_key'),
        'X-Internal-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_api_secret')
      ),
      body := '{"target": "automation-executor"}'::jsonb
    ) AS request_id;
    $cron$
  );

  -- Pre-generate nurture drafts 24–48h ahead. Daily at 08:00.
  PERFORM cron.schedule(
    'dispatch-nurture-pre-generate',
    '0 8 * * *',
    $cron$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_functions_url') || '/cron-dispatcher',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_anon_key'),
        'X-Internal-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_api_secret')
      ),
      body := '{"target": "nurture-pre-generate"}'::jsonb
    ) AS request_id;
    $cron$
  );

  -- Refresh Outlook webhook subscriptions before they expire. Every 12 hours.
  PERFORM cron.schedule(
    'dispatch-outlook-subscription-check',
    '0 */12 * * *',
    $cron$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_functions_url') || '/cron-dispatcher',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_anon_key'),
        'X-Internal-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_api_secret')
      ),
      body := '{"target": "outlook-subscription-check"}'::jsonb
    ) AS request_id;
    $cron$
  );

  -- Bulk Gmail sync to catch up on missed mail. Every 20 minutes.
  PERFORM cron.schedule(
    'dispatch-gmail-bulk-sync',
    '*/20 * * * *',
    $cron$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_functions_url') || '/cron-dispatcher',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_anon_key'),
        'X-Internal-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_api_secret')
      ),
      body := '{"target": "gmail-bulk-sync"}'::jsonb
    ) AS request_id;
    $cron$
  );

  -- Process queued WhatsApp events. Every minute (low-latency requirement).
  PERFORM cron.schedule(
    'dispatch-whatsapp-events',
    '* * * * *',
    $cron$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_functions_url') || '/cron-dispatcher',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_anon_key'),
        'X-Internal-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_api_secret')
      ),
      body := '{"target": "whatsapp-events-processor", "payload": {"trigger": "pg_cron"}}'::jsonb
    ) AS request_id;
    $cron$
  );

  -- Sales Brain promotion: turn captured winning interactions into KB chunks.
  -- Every 6 hours. This is the core differentiator — do not disable.
  PERFORM cron.schedule(
    'dispatch-promote-winning',
    '0 */6 * * *',
    $cron$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_functions_url') || '/cron-dispatcher',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_anon_key'),
        'X-Internal-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_api_secret')
      ),
      body := '{"target": "promote-winning-interactions"}'::jsonb
    ) AS request_id;
    $cron$
  );

  -- 72-hour message body purge (pilot brief commitment). Hourly.
  PERFORM cron.schedule(
    'dispatch-message-cleanup',
    '0 * * * *',
    $cron$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_functions_url') || '/cron-dispatcher',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_anon_key'),
        'X-Internal-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_api_secret')
      ),
      body := '{"target": "message-cleanup"}'::jsonb
    ) AS request_id;
    $cron$
  );

  -- Pre-generate inbox reply chip suggestions. Hourly at :30.
  PERFORM cron.schedule(
    'dispatch-reply-suggestions',
    '30 * * * *',
    $cron$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_functions_url') || '/cron-dispatcher',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_anon_key'),
        'X-Internal-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_api_secret')
      ),
      body := '{"target": "generate-reply-suggestions"}'::jsonb
    ) AS request_id;
    $cron$
  );

  -- Recompute manager analytics. Hourly at :15.
  PERFORM cron.schedule(
    'dispatch-manager-analytics',
    '15 * * * *',
    $cron$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_functions_url') || '/cron-dispatcher',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_anon_key'),
        'X-Internal-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_api_secret')
      ),
      body := '{"target": "compute-manager-analytics"}'::jsonb
    ) AS request_id;
    $cron$
  );

  -- Pull upcoming Google + Outlook calendar events. Every 15 minutes.
  -- Phase 1 of calendar awareness — populates `calendar_events` for the
  -- per-lead Meetings tab "Upcoming Meetings" section.
  PERFORM cron.schedule(
    'dispatch-calendar-sync',
    '*/15 * * * *',
    $cron$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_functions_url') || '/cron-dispatcher',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'staging_anon_key'),
        'X-Internal-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_api_secret')
      ),
      body := '{"target": "calendar-sync"}'::jsonb
    ) AS request_id;
    $cron$
  );

  -- ── Staging deviation: the live auto-sender stays OFF ──────────────────────
  -- Created above so the job exists (schedule/body mirror prod), disabled here
  -- so staging never auto-sends. The QA plan exercises the send path by manual
  -- invoke / review mode only (STAGING_TEST_PLAN.md → "Edge functions").
  UPDATE cron.job SET active = false WHERE jobname = 'dispatch-automation-executor';

  RAISE NOTICE 'codify_cron_jobs_staging: 10 dispatcher jobs (re)scheduled; dispatch-automation-executor left inactive.';
END
$mig$;
