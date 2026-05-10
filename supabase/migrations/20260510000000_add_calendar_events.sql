-- 20260510000000_add_calendar_events.sql
--
-- Phase 1 of calendar awareness: pull upcoming meetings from connected
-- Google Calendar and Outlook Calendar accounts, match attendees to leads,
-- and surface them in the per-lead Meetings tab.
--
-- This migration:
--   1. Adds `granted_scopes` + `needs_reconnect` to the two OAuth token
--      tables (`gmail_connections`, `mail_accounts`) so we can detect users
--      who connected before calendar scopes were requested and prompt them
--      to re-consent.
--   2. Adds `user_id` to `mail_accounts` (nullable) so calendar-sync knows
--      which Supabase user to attribute Outlook calendar events to. Existing
--      rows are NULL until the user reconnects.
--   3. Creates `calendar_events` for the upcoming-meeting cache.

-- ── 1. Token-table columns for scope tracking ──────────────────────────────

ALTER TABLE public.gmail_connections
  ADD COLUMN IF NOT EXISTS granted_scopes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS needs_reconnect boolean NOT NULL DEFAULT false;

ALTER TABLE public.mail_accounts
  ADD COLUMN IF NOT EXISTS granted_scopes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS needs_reconnect boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- ── 2. calendar_events table ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  external_event_id text NOT NULL,
  platform text CHECK (platform IN ('google_meet', 'teams', 'zoom', 'other')),
  title text,
  start_time timestamptz NOT NULL,
  end_time timestamptz,
  attendees_emails text[] NOT NULL DEFAULT '{}',
  meeting_url text,
  organizer_email text,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'in_progress', 'ended', 'cancelled')),
  raw_event jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, external_event_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_lead
  ON public.calendar_events (lead_id, start_time DESC);

-- Note: no partial-index predicate here — Postgres rejects now() in index
-- WHERE clauses (must be IMMUTABLE). The composite (workspace_id, start_time)
-- index is still used efficiently for "WHERE workspace_id = X AND start_time > now()"
-- via a normal range scan.
CREATE INDEX IF NOT EXISTS idx_calendar_events_workspace_upcoming
  ON public.calendar_events (workspace_id, start_time);

-- updated_at trigger (uses the existing helper function)
DROP TRIGGER IF EXISTS calendar_events_updated_at ON public.calendar_events;
CREATE TRIGGER calendar_events_updated_at
  BEFORE UPDATE ON public.calendar_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── 3. RLS ─────────────────────────────────────────────────────────────────

ALTER TABLE public.calendar_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read workspace events" ON public.calendar_events;
CREATE POLICY "members read workspace events"
  ON public.calendar_events
  FOR SELECT
  USING (is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "owner writes own events" ON public.calendar_events;
CREATE POLICY "owner writes own events"
  ON public.calendar_events
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
