
-- ============================================================
-- CALL SETTINGS (workspace-level config with defaults)
-- ============================================================
CREATE TABLE public.call_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  transcribe_min_duration_sec integer NOT NULL DEFAULT 10,
  analyze_min_duration_sec integer NOT NULL DEFAULT 30,
  default_language text NOT NULL DEFAULT 'en-US',
  supported_languages text[] NOT NULL DEFAULT ARRAY['en-US','es-US','fr-CA'],
  recording_notice_enabled boolean NOT NULL DEFAULT true,
  recording_require_dtmf_consent boolean NOT NULL DEFAULT false,
  audio_retention_days integer NOT NULL DEFAULT 90,
  webhook_base_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id)
);

ALTER TABLE public.call_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view call settings"
  ON public.call_settings FOR SELECT
  USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace admins can manage call settings"
  ON public.call_settings FOR ALL
  USING (is_workspace_admin(workspace_id, auth.uid()))
  WITH CHECK (is_workspace_admin(workspace_id, auth.uid()));

CREATE TRIGGER update_call_settings_updated_at
  BEFORE UPDATE ON public.call_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- CALL SESSIONS
-- ============================================================
CREATE TABLE public.call_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  call_sid text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_number text NOT NULL,
  to_number text NOT NULL,
  status text NOT NULL DEFAULT 'initiated',
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_sec integer,
  agent_user_id uuid,
  customer_contact_id uuid REFERENCES public.contacts(id),
  lead_id uuid REFERENCES public.leads(id),
  recording_consent_mode text NOT NULL DEFAULT 'notice-only' CHECK (recording_consent_mode IN ('notice-only','dtmf-consent','none')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(call_sid)
);

ALTER TABLE public.call_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view call sessions"
  ON public.call_sessions FOR SELECT
  USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Service role can manage call sessions"
  ON public.call_sessions FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE INDEX idx_call_sessions_workspace ON public.call_sessions(workspace_id);
CREATE INDEX idx_call_sessions_call_sid ON public.call_sessions(call_sid);
CREATE INDEX idx_call_sessions_lead ON public.call_sessions(lead_id);
CREATE INDEX idx_call_sessions_contact ON public.call_sessions(customer_contact_id);

CREATE TRIGGER update_call_sessions_updated_at
  BEFORE UPDATE ON public.call_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- CALL RECORDINGS
-- ============================================================
CREATE TABLE public.call_recordings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  call_session_id uuid NOT NULL REFERENCES public.call_sessions(id) ON DELETE CASCADE,
  recording_sid text NOT NULL,
  twilio_recording_url text,
  duration_sec integer,
  channels integer DEFAULT 1,
  format text DEFAULT 'wav',
  downloaded_at timestamptz,
  storage_url text,
  storage_provider text DEFAULT 'supabase',
  sha256 text,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','downloaded','failed','skipped_short')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(recording_sid)
);

ALTER TABLE public.call_recordings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view call recordings"
  ON public.call_recordings FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.call_sessions cs
    WHERE cs.id = call_recordings.call_session_id
    AND is_workspace_member(cs.workspace_id, auth.uid())
  ));

CREATE POLICY "Service role can manage call recordings"
  ON public.call_recordings FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE INDEX idx_call_recordings_session ON public.call_recordings(call_session_id);

CREATE TRIGGER update_call_recordings_updated_at
  BEFORE UPDATE ON public.call_recordings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- CALL TRANSCRIPTS
-- ============================================================
CREATE TABLE public.call_transcripts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  call_session_id uuid NOT NULL REFERENCES public.call_sessions(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'lovable-ai',
  language text NOT NULL DEFAULT 'en-US',
  confidence real,
  segments_json jsonb DEFAULT '[]'::jsonb,
  full_text text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed','skipped_short')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.call_transcripts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view call transcripts"
  ON public.call_transcripts FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.call_sessions cs
    WHERE cs.id = call_transcripts.call_session_id
    AND is_workspace_member(cs.workspace_id, auth.uid())
  ));

CREATE POLICY "Service role can manage call transcripts"
  ON public.call_transcripts FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE INDEX idx_call_transcripts_session ON public.call_transcripts(call_session_id);

CREATE TRIGGER update_call_transcripts_updated_at
  BEFORE UPDATE ON public.call_transcripts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- CALL ANALYSES (LLM outputs)
-- ============================================================
CREATE TABLE public.call_analyses (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  call_session_id uuid NOT NULL REFERENCES public.call_sessions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed','skipped_short')),
  model text,
  version text,
  summary_short text,
  summary_long text,
  action_items_json jsonb DEFAULT '[]'::jsonb,
  signals_json jsonb DEFAULT '{}'::jsonb,
  recommended_next_steps_json jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.call_analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view call analyses"
  ON public.call_analyses FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.call_sessions cs
    WHERE cs.id = call_analyses.call_session_id
    AND is_workspace_member(cs.workspace_id, auth.uid())
  ));

CREATE POLICY "Service role can manage call analyses"
  ON public.call_analyses FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE INDEX idx_call_analyses_session ON public.call_analyses(call_session_id);

CREATE TRIGGER update_call_analyses_updated_at
  BEFORE UPDATE ON public.call_analyses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- CALL WEBHOOK LOG (debug/audit)
-- ============================================================
CREATE TABLE public.call_webhook_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type text NOT NULL,
  call_sid text,
  payload jsonb NOT NULL DEFAULT '{}',
  processed_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.call_webhook_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage call webhook log"
  ON public.call_webhook_log FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE INDEX idx_call_webhook_log_call_sid ON public.call_webhook_log(call_sid);
CREATE INDEX idx_call_webhook_log_created ON public.call_webhook_log(created_at DESC);

-- ============================================================
-- STORAGE BUCKET for call recordings
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('call-recordings', 'call-recordings', false);

CREATE POLICY "Service role can manage call recordings storage"
  ON storage.objects FOR ALL
  USING (bucket_id = 'call-recordings')
  WITH CHECK (bucket_id = 'call-recordings');

CREATE POLICY "Workspace members can read call recordings storage"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'call-recordings');
