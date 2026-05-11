CREATE TABLE public.meeting_transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  calendar_event_id uuid NOT NULL UNIQUE REFERENCES public.calendar_events(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google_meet', 'microsoft_teams')),
  provider_meeting_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'fetching', 'ready', 'unavailable', 'failed')),
  status_reason text,
  transcript_text text,
  transcript_format text
    CHECK (transcript_format IN ('vtt', 'plaintext', 'json')),
  fetch_attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  ready_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_meeting_transcripts_workspace_status
  ON public.meeting_transcripts (workspace_id, status);
CREATE INDEX idx_meeting_transcripts_status_last_attempt
  ON public.meeting_transcripts (status, last_attempt_at);
CREATE INDEX idx_meeting_transcripts_lead
  ON public.meeting_transcripts (lead_id);
CREATE INDEX idx_meeting_transcripts_created_at
  ON public.meeting_transcripts (created_at);

CREATE TRIGGER meeting_transcripts_updated_at
  BEFORE UPDATE ON public.meeting_transcripts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.meeting_transcripts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read meeting transcripts"
  ON public.meeting_transcripts FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "members insert meeting transcripts"
  ON public.meeting_transcripts FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "members update meeting transcripts"
  ON public.meeting_transcripts FOR UPDATE
  USING (public.is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "admins delete meeting transcripts"
  ON public.meeting_transcripts FOR DELETE
  USING (public.is_workspace_admin(workspace_id, auth.uid()));

CREATE TABLE public.meeting_ai_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  meeting_transcript_id uuid UNIQUE REFERENCES public.meeting_transcripts(id) ON DELETE SET NULL,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  summary text,
  risks jsonb,
  milestones jsonb,
  action_items jsonb,
  open_questions jsonb,
  ai_model_used text,
  generated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_meeting_ai_summaries_workspace
  ON public.meeting_ai_summaries (workspace_id);
CREATE INDEX idx_meeting_ai_summaries_lead
  ON public.meeting_ai_summaries (lead_id);

CREATE TRIGGER meeting_ai_summaries_updated_at
  BEFORE UPDATE ON public.meeting_ai_summaries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.meeting_ai_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read meeting ai summaries"
  ON public.meeting_ai_summaries FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "members insert meeting ai summaries"
  ON public.meeting_ai_summaries FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "members update meeting ai summaries"
  ON public.meeting_ai_summaries FOR UPDATE
  USING (public.is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));
CREATE POLICY "admins delete meeting ai summaries"
  ON public.meeting_ai_summaries FOR DELETE
  USING (public.is_workspace_admin(workspace_id, auth.uid()));