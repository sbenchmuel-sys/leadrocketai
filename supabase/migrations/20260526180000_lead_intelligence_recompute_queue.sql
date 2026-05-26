-- 20260526180000_lead_intelligence_recompute_queue.sql
-- Auto-recompute queue for `recompute-lead-intelligence`.
--
-- Background: today the canonical `lead_intelligence` row only refreshes when
-- a user clicks "Run Analysis" on the lead detail page. After that, milestones
-- / risks / objections / buying_signals / recommended_next_step go stale the
-- moment new activity lands (inbound emails, call analyses, meeting summaries).
--
-- This migration introduces a coalescing queue plus per-table triggers that
-- enqueue affected leads when material signals land. A new cron job
-- (`dispatch-intelligence-queue-drain`, codified in a sibling migration) drains
-- the queue every 5 minutes by calling the `intelligence-queue-drain` edge
-- function, which in turn invokes `recompute-lead-intelligence` per lead.
--
-- Coalescing: PRIMARY KEY (lead_id) + ON CONFLICT DO NOTHING in each trigger
-- means N signals for the same lead within one drain window cost exactly ONE
-- recompute. So a burst of 5 inbound emails ≠ 5 AI calls.
--
-- Source tables wired:
--   • lead_timeline_items WHERE event_type = 'email_inbound'  (lead replied)
--   • call_analyses  (call got analyzed — joins via call_sessions for lead_id)
--   • meeting_summaries  (meeting recap generated — joins via leads for workspace_id)
--
-- Cost-protection guards (all triggers consult `should_recompute_for_lead`):
--   • leads.unsubscribed = TRUE                        → skip
--     (catches bounces from postmaster/mailer-daemon and human "stop"
--     replies — gmail-sync sets this flag BEFORE inserting the row, so
--     the trigger sees the updated lead.)
--   • leads.stage IN ('closed_won', 'closed_lost')     → skip
--   • Zero outbound activity from the rep ever         → skip
--     (covers detect-lead-candidates discoveries where the workspace
--     hasn't engaged, and prevents wasted spend on cold-imported leads.)
--
-- Additional guard on the timeline trigger:
--   • created_at - occurred_at > 30 minutes            → skip
--     (catches lookback-seed-candidates backfills — those insert real
--     `email_inbound` rows but with `occurred_at` from days/weeks ago.
--     Recomputing on historical data isn't urgent; user can click
--     "Run Analysis" manually if they need it.)
--
-- The manual "Run Analysis" button calls `recompute-lead-intelligence`
-- DIRECTLY and bypasses both the queue and these guards — so users can
-- always force a fresh analysis on any lead.
--
-- The drainer is also responsible for retry/backoff via `attempts` and
-- `last_error` — see supabase/functions/intelligence-queue-drain/index.ts.

CREATE TABLE IF NOT EXISTS public.lead_intelligence_recompute_queue (
  lead_id        UUID PRIMARY KEY REFERENCES public.leads(id) ON DELETE CASCADE,
  workspace_id   UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  queued_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source         TEXT NOT NULL,
  attempts       INT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  last_error     TEXT
);

-- Drainer pops oldest-first; this index makes that scan cheap.
CREATE INDEX IF NOT EXISTS idx_recompute_queue_queued_at
  ON public.lead_intelligence_recompute_queue (queued_at);

-- RLS: workspace-scoped read for members; only service role writes (triggers
-- run as the table owner so they bypass RLS regardless).
ALTER TABLE public.lead_intelligence_recompute_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "queue_select_workspace_members"
  ON public.lead_intelligence_recompute_queue;
CREATE POLICY "queue_select_workspace_members"
  ON public.lead_intelligence_recompute_queue
  FOR SELECT
  USING (public.is_workspace_member(workspace_id));

-- ── Enqueue helper ─────────────────────────────────────────────────────────
-- Wrapper so each trigger has identical write semantics. Skipping when
-- workspace_id is null prevents spurious failures for legacy/orphan rows.
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

-- ── Cost-protection gate ──────────────────────────────────────────────────
-- Decides whether a given lead is worth re-analyzing right now. Triggers
-- consult this BEFORE enqueueing, so wasteful AI spend never lands in the
-- queue in the first place.
--
-- Conservative by design: better to miss a few recomputes (user can always
-- click "Run Analysis" manually) than to burn tokens on cold/dead leads.
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

  -- Lead vanished mid-trigger → nothing to do.
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Rule 1: unsubscribed (covers bounces + human opt-outs).
  IF v_unsubscribed IS TRUE THEN
    RETURN FALSE;
  END IF;

  -- Rule 2: closed deals don't need fresh analysis.
  IF v_stage IN ('closed_won', 'closed_lost') THEN
    RETURN FALSE;
  END IF;

  -- Rule 3: zero engagement from the rep → nothing to analyze.
  -- Covers detect-lead-candidates discoveries on inbound-first leads and
  -- protects against wasted spend when the workspace has only imported
  -- (never reached out to) a lead.
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

-- ── Trigger 1: lead_timeline_items (inbound emails only) ───────────────────
CREATE OR REPLACE FUNCTION public.trg_enqueue_recompute_from_timeline()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Fast-rejection: only inbound emails on an attached lead.
  IF NEW.event_type <> 'email_inbound' OR NEW.lead_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Backfill guard: lookback-seed and other historical ingests insert
  -- email_inbound rows long after the message was actually received.
  -- Skip these — recomputing on stale data isn't worth the spend.
  IF NEW.occurred_at IS NOT NULL
     AND NEW.created_at - NEW.occurred_at > INTERVAL '30 minutes' THEN
    RETURN NEW;
  END IF;

  -- Per-lead engagement guards (unsubscribed / closed / never-engaged).
  IF NOT public.should_recompute_for_lead(NEW.lead_id) THEN
    RETURN NEW;
  END IF;

  PERFORM public.enqueue_lead_intelligence_recompute(
    NEW.lead_id,
    NEW.workspace_id,
    'email_inbound'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recompute_on_timeline_inbound
  ON public.lead_timeline_items;
CREATE TRIGGER trg_recompute_on_timeline_inbound
  AFTER INSERT ON public.lead_timeline_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_enqueue_recompute_from_timeline();

-- ── Trigger 2: call_analyses (join via call_sessions) ──────────────────────
-- We only enqueue once the analysis row reaches a final state. The status
-- check keeps in-flight rows (initial INSERT before AI completes) from
-- triggering premature recomputes.
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

DROP TRIGGER IF EXISTS trg_recompute_on_call_analysis
  ON public.call_analyses;
CREATE TRIGGER trg_recompute_on_call_analysis
  AFTER INSERT OR UPDATE OF status ON public.call_analyses
  FOR EACH ROW EXECUTE FUNCTION public.trg_enqueue_recompute_from_call_analysis();

-- ── Trigger 3: meeting_summaries (join via leads for workspace_id) ─────────
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

DROP TRIGGER IF EXISTS trg_recompute_on_meeting_summary
  ON public.meeting_summaries;
CREATE TRIGGER trg_recompute_on_meeting_summary
  AFTER INSERT ON public.meeting_summaries
  FOR EACH ROW EXECUTE FUNCTION public.trg_enqueue_recompute_from_meeting_summary();

COMMENT ON TABLE public.lead_intelligence_recompute_queue IS
  'Coalescing queue for auto-triggered Run Analysis. Drained every 5 min by intelligence-queue-drain edge function. PK(lead_id) means N signals = 1 recompute per drain window.';
