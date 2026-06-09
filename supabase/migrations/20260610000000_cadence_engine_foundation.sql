-- ═══════════════════════════════════════════════
-- Cadence engine foundation (Outreach Unit B / full-refactor track — PR B1)
--
-- Replaces the reactive, lead-row-derived cadence model (leads.next_action_key
-- / leads.eligible_at re-derived on every sync by syncEngine.deriveAction) with
-- a proper, proactive two-table model:
--
--   cadence_enrollments  — one row per (lead enrolled in a campaign): WHERE the
--                          lead currently sits in that campaign. The lead's
--                          position in the cadence.
--   cadence_touches      — one row per individual planned step for an
--                          enrollment: every auto send AND every manual task
--                          (call / LinkedIn / SMS) is a row here. A "manual
--                          task" is simply a touch with execution_mode='manual'
--                          awaiting a rep — there is NO separate cadence_tasks
--                          table.
--
-- ── SCHEMA ONLY. No behavior change. ────────────────────────────────
-- Nothing reads or writes these tables yet. The proactive step-walker that
-- materializes touches and advances enrollments lands in PR B2; the executor
-- cutover (sender reads cadence_touches instead of querying leads) lands in
-- PR B3; the mark-done RPC lands in PR B4. Email *content* generation
-- (campaignResolver) is untouched by this track — only the scheduling/selection
-- layer changes — so the byte-identical golden test stays valid throughout.
--
-- Additive only. Does NOT alter leads / campaigns / campaign_steps, does NOT
-- touch interactions / lead_timeline_items or automation_log / automation_logs,
-- and does NOT change behavior for the live (currently empty) cadence.
--
-- ── WORKSPACE ISOLATION ─────────────────────────────────────────────
-- workspace_id is stored DIRECTLY on both tables (NOT derived from leads —
-- leads.workspace_id is nullable). The writer (the B2 engine) sources it from
-- the parent campaign, whose workspace_id is NOT NULL. RLS gates every row on
-- is_workspace_member(workspace_id, auth.uid()).
--
-- ── WRITE PATH (deliberate tightening vs campaign_steps precedent) ──
-- These tables drive the production sender, so they are NOT member-writable.
-- Members get SELECT only (Queue / Lead Detail need to read). ALL mutations
-- flow through service_role: the B2 engine (service role) and the B4 mark-done
-- RPC (SECURITY DEFINER). This mirrors how set_timeline_followup_state is the
-- only write path for follow-up state — a rep (or a compromised client) must
-- not be able to flip a touch to 'sent' or re-enroll a lead by writing the
-- table directly. drivepilot-qa: please confirm this posture is what we want.
-- ═══════════════════════════════════════════════

-- ── 1. cadence_enrollments ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cadence_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,

  -- active   = progressing through steps
  -- paused   = temporarily halted, resumable (e.g. pause-on-reply waiting)
  -- stopped  = hard, terminal halt (do-not-contact / unsubscribe)
  -- completed = ran through the last step
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'stopped', 'completed')),
  status_reason text,                       -- 'reply' | 'do_not_contact' | 'manual' | …

  -- Highest step_number completed so far (0 = nothing sent yet). The engine
  -- materializes the next touch for step (current_step_number + 1), bounded by
  -- the campaign's step count.
  current_step_number integer NOT NULL DEFAULT 0,

  enrolled_at timestamptz NOT NULL DEFAULT now(),
  paused_at timestamptz,
  stopped_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One enrollment row per (lead, campaign). Re-enrollment reuses/reactivates
  -- this row rather than inserting a duplicate — a guard against a lead ending
  -- up in two concurrent runs of the same campaign.
  UNIQUE (lead_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_cadence_enrollments_workspace
  ON public.cadence_enrollments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_cadence_enrollments_lead
  ON public.cadence_enrollments(lead_id);
CREATE INDEX IF NOT EXISTS idx_cadence_enrollments_campaign
  ON public.cadence_enrollments(campaign_id);
-- Engine scan: "give me the active enrollments to advance."
CREATE INDEX IF NOT EXISTS idx_cadence_enrollments_active
  ON public.cadence_enrollments(status)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS update_cadence_enrollments_updated_at ON public.cadence_enrollments;
CREATE TRIGGER update_cadence_enrollments_updated_at
  BEFORE UPDATE ON public.cadence_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── 2. cadence_touches ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cadence_touches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  enrollment_id uuid NOT NULL REFERENCES public.cadence_enrollments(id) ON DELETE CASCADE,
  -- Denormalized from the enrollment for cheap Queue / sender scans without a
  -- join. Kept consistent by the engine (writes go through service_role only).
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,

  -- (campaign_id, step_number) resolves the campaign_steps row. Intentionally
  -- NOT a hard FK to campaign_steps.id so editing / reordering steps never
  -- breaks historical touch rows.
  step_number integer NOT NULL,

  -- Mirrors campaign_steps.channel (plain TEXT, no enum there): email | voice |
  -- sms | linkedin | whatsapp.
  channel text NOT NULL DEFAULT 'email',

  -- The load-bearing discriminator that keeps manual work out of the sender:
  --   auto   = the executor sends it (email today; SMS/WhatsApp if ever automated)
  --   manual = a rep does it from the Queue (call / LinkedIn / rep-confirmed SMS)
  -- The B3 executor only ever picks status='scheduled' AND execution_mode='auto'.
  execution_mode text NOT NULL DEFAULT 'auto'
    CHECK (execution_mode IN ('auto', 'manual')),

  -- scheduled = pending (auto: awaiting send window; manual: awaiting the rep)
  -- sent      = auto email dispatched
  -- done      = completed (auto send confirmed, or manual touch marked done)
  -- skipped   = rep skipped the manual touch
  -- failed    = auto send failed
  -- canceled  = a pause/stop on the enrollment cleared this still-pending touch
  --             (this is the fix for today's pause-on-reply gap, where pending
  --             work was orphaned rather than cancelled)
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'sent', 'done', 'skipped', 'failed', 'canceled')),

  scheduled_for timestamptz,                -- eligibility time (replaces leads.eligible_at)
  executed_at timestamptz,                  -- when sent / done
  completed_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  outcome text,                             -- calls: 'completed' | 'voicemail' | 'no_answer'; general result
  reason text,                              -- skip / cancel / do-not-contact note
  -- Link to the lead_timeline_items ledger row written when the touch completes
  -- (set by B4). ON DELETE SET NULL so purging a timeline row never deletes the touch.
  timeline_item_id uuid REFERENCES public.lead_timeline_items(id) ON DELETE SET NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One touch per step per enrollment. Makes engine materialization idempotent
  -- (it cannot create two touches for the same step) and makes retries an
  -- UPDATE of this row's status, not a duplicate insert.
  UNIQUE (enrollment_id, step_number)
);

CREATE INDEX IF NOT EXISTS idx_cadence_touches_workspace
  ON public.cadence_touches(workspace_id);
CREATE INDEX IF NOT EXISTS idx_cadence_touches_enrollment
  ON public.cadence_touches(enrollment_id);
-- Queue: "the touches for this lead."
CREATE INDEX IF NOT EXISTS idx_cadence_touches_lead
  ON public.cadence_touches(lead_id);
-- Sender / engine scan: pending auto sends whose time has come.
CREATE INDEX IF NOT EXISTS idx_cadence_touches_due_auto
  ON public.cadence_touches(scheduled_for)
  WHERE status = 'scheduled' AND execution_mode = 'auto';
-- Queue scan: a rep's pending manual touches.
CREATE INDEX IF NOT EXISTS idx_cadence_touches_pending_manual
  ON public.cadence_touches(workspace_id, scheduled_for)
  WHERE status = 'scheduled' AND execution_mode = 'manual';

DROP TRIGGER IF EXISTS update_cadence_touches_updated_at ON public.cadence_touches;
CREATE TRIGGER update_cadence_touches_updated_at
  BEFORE UPDATE ON public.cadence_touches
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── 3. RLS — members READ; service_role writes ──────────────────────
ALTER TABLE public.cadence_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cadence_touches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view cadence enrollments" ON public.cadence_enrollments;
CREATE POLICY "Members can view cadence enrollments"
  ON public.cadence_enrollments FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Service role full access on cadence_enrollments" ON public.cadence_enrollments;
CREATE POLICY "Service role full access on cadence_enrollments"
  ON public.cadence_enrollments FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Members can view cadence touches" ON public.cadence_touches;
CREATE POLICY "Members can view cadence touches"
  ON public.cadence_touches FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Service role full access on cadence_touches" ON public.cadence_touches;
CREATE POLICY "Service role full access on cadence_touches"
  ON public.cadence_touches FOR ALL TO service_role
  USING (true) WITH CHECK (true);
