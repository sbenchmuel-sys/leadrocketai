-- 20260526180000_lead_intelligence_recompute_queue.sql + 20260526180100_codify_cron_intelligence_queue_drain.sql
CREATE TABLE IF NOT EXISTS public.lead_intelligence_recompute_queue (
  lead_id        UUID PRIMARY KEY REFERENCES public.leads(id) ON DELETE CASCADE,
  workspace_id   UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  queued_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source         TEXT NOT NULL,
  attempts       INT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  last_error     TEXT
);

GRANT SELECT ON public.lead_intelligence_recompute_queue TO authenticated;
GRANT ALL ON public.lead_intelligence_recompute_queue TO service_role;

CREATE INDEX IF NOT EXISTS idx_recompute_queue_queued_at
  ON public.lead_intelligence_recompute_queue (queued_at);

ALTER TABLE public.lead_intelligence_recompute_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "queue_select_workspace_members"
  ON public.lead_intelligence_recompute_queue;
CREATE POLICY "queue_select_workspace_members"
  ON public.lead_intelligence_recompute_queue
  FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE OR REPLACE FUNCTION public.enqueue_lead_intelligence_recompute(
  p_lead_id UUID,
  p_workspace_id UUID,
  p_source TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_lead_id IS NULL OR p_workspace_id IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.lead_intelligence_recompute_queue (lead_id, workspace_id, source)
  VALUES (p_lead_id, p_workspace_id, p_source)
  ON CONFLICT (lead_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.should_recompute_for_lead(p_lead_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unsubscribed BOOLEAN;
  v_stage        TEXT;
  v_outbound_n   INT;
BEGIN
  SELECT unsubscribed, stage
    INTO v_unsubscribed, v_stage
  FROM public.leads
  WHERE id = p_lead_id;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  IF v_unsubscribed IS TRUE THEN
    RETURN FALSE;
  END IF;
  IF v_stage IN ('closed_won', 'closed_lost') THEN
    RETURN FALSE;
  END IF;
  SELECT COUNT(*) INTO v_outbound_n
  FROM public.lead_timeline_items
  WHERE lead_id = p_lead_id
    AND event_type IN ('email_outbound', 'sms_outbound', 'whatsapp_outbound');
  IF v_outbound_n = 0 THEN
    RETURN FALSE;
  END IF;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_enqueue_recompute_from_timeline()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.event_type <> 'email_inbound' OR NEW.lead_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.occurred_at IS NOT NULL
     AND NEW.created_at - NEW.occurred_at > INTERVAL '30 minutes' THEN
    RETURN NEW;
  END IF;
  IF NOT public.should_recompute_for_lead(NEW.lead_id) THEN
    RETURN NEW;
  END IF;
  PERFORM public.enqueue_lead_intelligence_recompute(
    NEW.lead_id, NEW.workspace_id, 'email_inbound'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recompute_on_timeline_inbound ON public.lead_timeline_items;
CREATE TRIGGER trg_recompute_on_timeline_inbound
  AFTER INSERT ON public.lead_timeline_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_enqueue_recompute_from_timeline();

CREATE OR REPLACE FUNCTION public.trg_enqueue_recompute_from_call_analysis()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead_id UUID;
  v_workspace_id UUID;
BEGIN
  IF NEW.status IS NULL OR NEW.status NOT IN ('completed', 'analyzed', 'success') THEN
    RETURN NEW;
  END IF;
  SELECT lead_id, workspace_id INTO v_lead_id, v_workspace_id
  FROM public.call_sessions
  WHERE id = NEW.call_session_id;
  IF v_lead_id IS NULL OR NOT public.should_recompute_for_lead(v_lead_id) THEN
    RETURN NEW;
  END IF;
  PERFORM public.enqueue_lead_intelligence_recompute(
    v_lead_id, v_workspace_id, 'call_analysis'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recompute_on_call_analysis ON public.call_analyses;
CREATE TRIGGER trg_recompute_on_call_analysis
  AFTER INSERT OR UPDATE OF status ON public.call_analyses
  FOR EACH ROW EXECUTE FUNCTION public.trg_enqueue_recompute_from_call_analysis();

CREATE OR REPLACE FUNCTION public.trg_enqueue_recompute_from_meeting_summary()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id UUID;
BEGIN
  IF NEW.lead_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT workspace_id INTO v_workspace_id
  FROM public.leads
  WHERE id = NEW.lead_id;
  IF NOT public.should_recompute_for_lead(NEW.lead_id) THEN
    RETURN NEW;
  END IF;
  PERFORM public.enqueue_lead_intelligence_recompute(
    NEW.lead_id, v_workspace_id, 'meeting_summary'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recompute_on_meeting_summary ON public.meeting_summaries;
CREATE TRIGGER trg_recompute_on_meeting_summary
  AFTER INSERT ON public.meeting_summaries
  FOR EACH ROW EXECUTE FUNCTION public.trg_enqueue_recompute_from_meeting_summary();

COMMENT ON TABLE public.lead_intelligence_recompute_queue IS
  'Coalescing queue for auto-triggered Run Analysis. Drained every 5 min by intelligence-queue-drain edge function.';

-- ── Cron: schedule 5-minute drain ──
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

DO $cleanup$
DECLARE
  jid BIGINT;
BEGIN
  FOR jid IN
    SELECT jobid FROM cron.job
    WHERE jobname = 'dispatch-intelligence-queue-drain'
  LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END
$cleanup$;

SELECT cron.schedule(
  'dispatch-intelligence-queue-drain',
  '*/5 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://ntzeiflqqluwgdfmatjh.supabase.co/functions/v1/cron-dispatcher',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50emVpZmxxcWx1d2dkZm1hdGpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDE5ODgsImV4cCI6MjA4NjMxNzk4OH0.3uw7Tx3wv2EX8m82VtnY-M33K2ey4Yzhci6XnwZFPko"}'::jsonb,
    body := '{"target": "intelligence-queue-drain"}'::jsonb
  ) AS request_id;
  $cron$
);