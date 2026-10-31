-- ═══════════════════════════════════════════════════════════════════
-- Client pilot report emails (Monday recap + instant "hot reply" alerts).
--
-- Companion to:
--   • supabase/functions/pilot-reports/index.ts (the sender)
--   • supabase/functions/_shared/pilotReportEmail.ts (wording + timing, tested)
--   • supabase/functions/cron-dispatcher/index.ts (ALLOWED_TARGETS — same PR)
--   • 20261031120000_pilot_report.sql (the numbers)
--
-- One settings row per workspace that has a client pilot. No UI yet: the founder
-- inserts/edits the row (see the PR body). preview_only=true sends ONLY to
-- preview_recipients (with a "Preview" banner) so the first reports can be
-- checked before the client sees them.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.pilot_report_settings (
  workspace_id uuid PRIMARY KEY REFERENCES public.workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  client_name text NOT NULL,
  recipients text[] NOT NULL DEFAULT '{}',
  preview_only boolean NOT NULL DEFAULT true,
  preview_recipients text[] NOT NULL DEFAULT '{}',
  -- The mailbox the reports are sent FROM (an Outlook mail_accounts row) and its owner.
  sender_mail_account_id uuid NOT NULL REFERENCES public.mail_accounts(id) ON DELETE RESTRICT,
  sender_user_id uuid NOT NULL,
  -- The pilot rep(s). Reports, alerts and "coming up" count ONLY their leads and
  -- calls, so a client admin's own pipeline in the same workspace never shows up.
  -- Empty = nothing is reported yet (fill it in once the rep has signed in).
  rep_user_ids uuid[] NOT NULL DEFAULT '{}',
  pilot_start date NOT NULL,
  pilot_weeks integer NOT NULL DEFAULT 12,
  meetings_target integer,
  weekly_enabled boolean NOT NULL DEFAULT true,
  alerts_enabled boolean NOT NULL DEFAULT true,
  last_weekly_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pilot_report_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins read pilot report settings" ON public.pilot_report_settings;
CREATE POLICY "Admins read pilot report settings" ON public.pilot_report_settings
  FOR SELECT TO authenticated USING (public.is_workspace_admin(workspace_id, auth.uid()));
DROP TRIGGER IF EXISTS update_pilot_report_settings_updated_at ON public.pilot_report_settings;
CREATE TRIGGER update_pilot_report_settings_updated_at
  BEFORE UPDATE ON public.pilot_report_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- One row per timeline item already alerted, so a later update to the same item
-- (e.g. the 72h snippet purge bumping updated_at) can never re-send the alert.
CREATE TABLE IF NOT EXISTS public.pilot_report_alerts_sent (
  timeline_item_id uuid PRIMARY KEY REFERENCES public.lead_timeline_items(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pilot_report_alerts_sent ENABLE ROW LEVEL SECURITY;
-- No policies: service role only.

-- Every 15 minutes: the function itself decides whether the Monday recap is due
-- (Monday from 08:00 in the workspace time zone, once a week) and sends any new
-- hot-reply alerts.
-- ⚠️ HARDCODED KEY: same anon key as the other dispatcher crons (see CLAUDE.md →
-- "Open hazards"). Rotate in lockstep.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;
DO $cleanup$
DECLARE jid BIGINT;
BEGIN
  FOR jid IN SELECT jobid FROM cron.job WHERE jobname = 'cron_pilot_reports' LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END
$cleanup$;
SELECT cron.schedule(
  'cron_pilot_reports',
  '*/15 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := ('{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb || jsonb_build_object('X-Internal-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_api_secret'))),
    body := '{"target": "pilot-reports"}'::jsonb
  ) AS request_id;
  $cron$
);
