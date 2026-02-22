
-- ============================================================
-- Phase 2A: channel_events — ingest-only event inbox
-- ============================================================

CREATE TABLE public.channel_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NULL,
  channel text NOT NULL DEFAULT 'whatsapp',
  provider text NOT NULL DEFAULT 'meta',
  event_type text NOT NULL,
  provider_event_id text NOT NULL,
  payload_normalized jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  processed_at timestamptz NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Dedupe constraint: one event per provider+provider_event_id
ALTER TABLE public.channel_events
  ADD CONSTRAINT channel_events_provider_event_unique UNIQUE (provider, provider_event_id);

-- Index for processor to find unprocessed events quickly
CREATE INDEX idx_channel_events_unprocessed
  ON public.channel_events (created_at)
  WHERE processed_at IS NULL;

-- Index for workspace scoped queries
CREATE INDEX idx_channel_events_workspace
  ON public.channel_events (workspace_id, created_at DESC)
  WHERE workspace_id IS NOT NULL;

-- Enable RLS
ALTER TABLE public.channel_events ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (edge functions use service role)
CREATE POLICY "Service role full access on channel_events"
  ON public.channel_events
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Workspace members can view their events (read-only)
CREATE POLICY "Workspace members can view channel events"
  ON public.channel_events
  FOR SELECT
  USING (workspace_id IS NOT NULL AND is_workspace_member(workspace_id, auth.uid()));
