-- 20260427230000_codify_cron_jobs.sql
-- Codify the 9 cron-dispatcher jobs that drive scheduled work, into a tracked migration.
--
-- Background: prior to this migration, these crons lived only in the live database
-- (configured via the Supabase Dashboard). They were not in any migration file,
-- which meant they could not be restored from git on a fresh project, and schedule
-- changes had no audit trail.
--
-- This migration captures the live state as of 2026-04-27. It is idempotent:
-- re-running deletes the existing jobs by name and recreates them. Safe to apply
-- multiple times.
--
-- NOTE: `expire-messages-direct` (hourly SQL-only job) is intentionally NOT
-- included here — it is already established by 20260223154653_*.sql and uses a
-- different invocation pattern (direct SQL, not the dispatcher).
--
-- ⚠️ HARDCODED SECRETS: each command below embeds the Supabase project URL and
-- the anon key. These match the values currently active in the live `cron.job`
-- table. When the anon key is rotated, this migration must be updated AND the
-- live crons updated in lockstep, or scheduled jobs will silently break.
-- A future migration should parameterize these via Supabase Vault or a settings
-- table. Tracked in CLAUDE.md → "Open hazards".
--
-- AUTHORITATIVE SOURCE: the live `cron.job` table is the source of truth. This
-- migration is its audit trail. Verify drift with:
--   SELECT jobname, schedule FROM cron.job ORDER BY jobname;

-- Ensure required extensions exist (no-op if already enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

-- ── Idempotent cleanup: unschedule existing jobs by name ─────────────────────
-- cron.unschedule(name) errors when the name doesn't exist; iterate by jobid
-- so missing rows are silently skipped.
DO $cleanup$
DECLARE
  jid BIGINT;
BEGIN
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
      'dispatch-manager-analytics'
    ])
  LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END
$cleanup$;

-- ── Schedule the 9 dispatcher jobs ───────────────────────────────────────────

-- Send queued automation drips. Every 15 minutes; the executor itself filters
-- by per-workspace local-time send windows.
SELECT cron.schedule(
  'dispatch-automation-executor',
  '*/15 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "automation-executor"}'::jsonb
  ) AS request_id;
  $cron$
);

-- Pre-generate nurture drafts 24–48h ahead. Daily at 08:00.
SELECT cron.schedule(
  'dispatch-nurture-pre-generate',
  '0 8 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "nurture-pre-generate"}'::jsonb
  ) AS request_id;
  $cron$
);

-- Refresh Outlook webhook subscriptions before they expire. Every 12 hours.
SELECT cron.schedule(
  'dispatch-outlook-subscription-check',
  '0 */12 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "outlook-subscription-check"}'::jsonb
  ) AS request_id;
  $cron$
);

-- Bulk Gmail sync to catch up on missed mail. Every 20 minutes.
SELECT cron.schedule(
  'dispatch-gmail-bulk-sync',
  '*/20 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "gmail-bulk-sync"}'::jsonb
  ) AS request_id;
  $cron$
);

-- Process queued WhatsApp events. Every minute (low-latency requirement).
SELECT cron.schedule(
  'dispatch-whatsapp-events',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "whatsapp-events-processor", "payload": {"trigger": "pg_cron"}}'::jsonb
  ) AS request_id;
  $cron$
);

-- Sales Brain promotion: turn captured winning interactions into KB chunks.
-- Every 6 hours. This is the core differentiator — do not disable.
SELECT cron.schedule(
  'dispatch-promote-winning',
  '0 */6 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "promote-winning-interactions"}'::jsonb
  ) AS request_id;
  $cron$
);

-- 72-hour message body purge (pilot brief commitment). Hourly.
SELECT cron.schedule(
  'dispatch-message-cleanup',
  '0 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "message-cleanup"}'::jsonb
  ) AS request_id;
  $cron$
);

-- Pre-generate inbox reply chip suggestions. Hourly at :30.
SELECT cron.schedule(
  'dispatch-reply-suggestions',
  '30 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "generate-reply-suggestions"}'::jsonb
  ) AS request_id;
  $cron$
);

-- Recompute manager analytics. Hourly at :15.
SELECT cron.schedule(
  'dispatch-manager-analytics',
  '15 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "compute-manager-analytics"}'::jsonb
  ) AS request_id;
  $cron$
);
