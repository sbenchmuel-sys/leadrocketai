ALTER TABLE public.gmail_connections
  ADD COLUMN IF NOT EXISTS granted_scopes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS needs_reconnect boolean NOT NULL DEFAULT false;

ALTER TABLE public.mail_accounts
  ADD COLUMN IF NOT EXISTS granted_scopes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS needs_reconnect boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

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

CREATE INDEX IF NOT EXISTS idx_calendar_events_workspace_upcoming
  ON public.calendar_events (workspace_id, start_time);

DROP TRIGGER IF EXISTS calendar_events_updated_at ON public.calendar_events;
CREATE TRIGGER calendar_events_updated_at
  BEFORE UPDATE ON public.calendar_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

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