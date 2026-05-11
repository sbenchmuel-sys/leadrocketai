-- ── meeting_transcripts ↔ calendar_events ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_meeting_transcript_calendar_event_workspace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM 1 FROM public.calendar_events
  WHERE id = NEW.calendar_event_id AND workspace_id = NEW.workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'meeting_transcripts workspace_id (%) does not match calendar_events workspace_id for calendar_event_id (%)',
      NEW.workspace_id, NEW.calendar_event_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_meeting_transcript_calendar_event_workspace ON public.meeting_transcripts;
CREATE TRIGGER trg_enforce_meeting_transcript_calendar_event_workspace
  BEFORE INSERT OR UPDATE OF workspace_id, calendar_event_id ON public.meeting_transcripts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_meeting_transcript_calendar_event_workspace();

-- ── meeting_transcripts ↔ leads ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_meeting_transcript_lead_workspace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM 1 FROM public.leads
  WHERE id = NEW.lead_id AND workspace_id = NEW.workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'meeting_transcripts workspace_id (%) does not match leads workspace_id for lead_id (%)',
      NEW.workspace_id, NEW.lead_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_meeting_transcript_lead_workspace ON public.meeting_transcripts;
CREATE TRIGGER trg_enforce_meeting_transcript_lead_workspace
  BEFORE INSERT OR UPDATE OF workspace_id, lead_id ON public.meeting_transcripts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_meeting_transcript_lead_workspace();

-- ── meeting_ai_summaries ↔ leads ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_meeting_ai_summary_lead_workspace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM 1 FROM public.leads
  WHERE id = NEW.lead_id AND workspace_id = NEW.workspace_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'meeting_ai_summaries workspace_id (%) does not match leads workspace_id for lead_id (%)',
      NEW.workspace_id, NEW.lead_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_meeting_ai_summary_lead_workspace ON public.meeting_ai_summaries;
CREATE TRIGGER trg_enforce_meeting_ai_summary_lead_workspace
  BEFORE INSERT OR UPDATE OF workspace_id, lead_id ON public.meeting_ai_summaries
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_meeting_ai_summary_lead_workspace();

-- ── meeting_ai_summaries ↔ meeting_transcripts ─────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_meeting_ai_summary_transcript_workspace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.meeting_transcript_id IS NOT NULL THEN
    PERFORM 1 FROM public.meeting_transcripts
    WHERE id = NEW.meeting_transcript_id AND workspace_id = NEW.workspace_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'meeting_ai_summaries workspace_id (%) does not match meeting_transcripts workspace_id for meeting_transcript_id (%)',
        NEW.workspace_id, NEW.meeting_transcript_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_meeting_ai_summary_transcript_workspace ON public.meeting_ai_summaries;
CREATE TRIGGER trg_enforce_meeting_ai_summary_transcript_workspace
  BEFORE INSERT OR UPDATE OF workspace_id, meeting_transcript_id ON public.meeting_ai_summaries
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_meeting_ai_summary_transcript_workspace();