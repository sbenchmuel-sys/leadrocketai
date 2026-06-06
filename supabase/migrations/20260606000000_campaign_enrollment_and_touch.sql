-- ═══════════════════════════════════════════════════════════════════
-- Outreach Unit C (PR 1) — enrollment + per-touch cadence schema.
--
-- Additive only. Does NOT change behavior for any lead that is not
-- enrolled in a cold campaign (i.e. has no campaign_enrollment row).
-- No edge function in THIS migration → config.toml untouched. Does NOT
-- touch interactions / lead_timeline_items or automation_log(s).
--
-- The two new tables are the SOURCE OF TRUTH for a cold campaign's
-- cadence and the Outreach queue. automation-executor stays a guarded
-- send primitive and is NOT changed here (that is PR 2). With no
-- scheduler and no executor change yet, nothing reads these rows to
-- send — so applying this migration cannot send a single email. The
-- consent gate still fail-closes every lead: enrollment deliberately
-- does NOT set leads.automation_mode / needs_action / eligible_at, so
-- the existing executor candidate query never picks an enrolled lead up.
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. Per-campaign send mode (default REVIEW) ──────────────────────
-- review  → cadence runs + drafts each email, but email touches surface
--           in the Outreach queue as approve-cards; the rep clicks Send.
-- automatic → email touches auto-send through automation-executor,
--           behind the workspace cold_auto_send_enabled gate (PR 2).
-- Default REVIEW so a freshly built outreach never auto-sends cold email
-- until the rep deliberately switches it on.
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS send_mode TEXT NOT NULL DEFAULT 'review';

ALTER TABLE public.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_send_mode_check;
ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_send_mode_check
  CHECK (send_mode IN ('review', 'automatic'));

-- ── 2. Workspace cold auto-send gate (default OFF) ──────────────────
-- An ADDITIONAL floor on AUTOMATIC mode only. Mirrors the WhatsApp
-- automation toggle pattern. Building / enrolling / review / all manual
-- touches work regardless of this flag; it only gates cold auto-EMAIL.
-- automation-executor reads it (PR 2) and ALSO fail-closes when the
-- workspace timezone is NULL (Unit 0). OFF by default — a workspace must
-- explicitly opt in once its Unit 0 safeguards are live.
ALTER TABLE public.workspace_automation_settings
  ADD COLUMN IF NOT EXISTS cold_auto_send_enabled BOOLEAN NOT NULL DEFAULT false;

-- ── 3. Company CAN-SPAM postal address (user-entered only) ──────────
-- Workspace-scoped (one company address, not per-rep) and ENTERED BY A
-- HUMAN — never AI-populated (unlike rep_profiles.office_address, which
-- extract-profile-from-kb can fill and is therefore unreliable for a
-- legal requirement). Cold sending (auto AND review) fail-closes when
-- this is blank (enforced in the send helper, PR 2): a cold email with
-- no physical address is a CAN-SPAM violation.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS cold_outreach_postal_address TEXT;

COMMENT ON COLUMN public.workspaces.cold_outreach_postal_address IS
  'User-entered company mailing address for the CAN-SPAM footer on cold outreach emails. NEVER AI-populated. When blank, cold sending (automatic and review) is blocked.';

-- ── 4. campaign_enrollment ──────────────────────────────────────────
-- One row per (lead × campaign). The cold discriminator: a lead with an
-- enrollment row is on the scheduler-owned cold cadence, so the executor
-- suppresses its own step self-advance for it (PR 2). started_at is the
-- lead's OWN day-0 anchor (staggered at enrollment); the cadence is
-- always relative to it, never a shared calendar.
CREATE TABLE IF NOT EXISTS public.campaign_enrollment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'active', 'replied', 'paused', 'completed', 'stopped')),
  current_step_number integer NOT NULL DEFAULT 0,
  started_at timestamptz,               -- day-0 anchor (may be future when staggered)
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, lead_id)         -- never double-enroll the same lead
);

CREATE INDEX IF NOT EXISTS campaign_enrollment_campaign_idx
  ON public.campaign_enrollment (campaign_id);
CREATE INDEX IF NOT EXISTS campaign_enrollment_lead_idx
  ON public.campaign_enrollment (lead_id);
CREATE INDEX IF NOT EXISTS campaign_enrollment_status_idx
  ON public.campaign_enrollment (status);

CREATE TRIGGER update_campaign_enrollment_updated_at
  BEFORE UPDATE ON public.campaign_enrollment
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.campaign_enrollment ENABLE ROW LEVEL SECURITY;

-- RLS mirrors campaign_step_content: members of the parent campaign's
-- workspace manage; service_role full access (the scheduler runs as
-- service role).
CREATE POLICY "Members can view campaign enrollment"
  ON public.campaign_enrollment FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_enrollment.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
  ));

CREATE POLICY "Members can manage campaign enrollment"
  ON public.campaign_enrollment FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_enrollment.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_enrollment.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
  ));

CREATE POLICY "Service role full access on campaign_enrollment"
  ON public.campaign_enrollment FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── 5. campaign_touch ───────────────────────────────────────────────
-- One row per scheduled touch per enrolled lead. SOURCE OF TRUTH for the
-- Outreach queue (status='queued'), aggregate bounce rate, and capacity.
-- channel mirrors campaign_steps.channel (+ 'linkedin', which arrives as
-- a CanonicalChannel in a later unit; allowed here so the manual-touch
-- card is channel-generic). EMAIL touches either auto-send (automatic)
-- or surface as an approve-card (review); all other channels are MANUAL
-- and never auto-marked sent.
CREATE TABLE IF NOT EXISTS public.campaign_touch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid NOT NULL REFERENCES public.campaign_enrollment(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  step_number integer NOT NULL,
  channel text NOT NULL
    CHECK (channel IN ('email', 'voice', 'sms', 'whatsapp', 'linkedin')),
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'queued', 'sent', 'skipped', 'auto_skipped', 'failed')),
  eligible_at timestamptz,              -- when this touch becomes due (lead-relative)
  max_age_at timestamptz,               -- auto-skip deadline; NULL = no max age
  call_outcome text
    CHECK (call_outcome IN ('got_them', 'no_answer')),   -- call touches only
  sent_at timestamptz,
  draft_id uuid,                        -- review-mode email → drafts.id
  automation_log_id uuid,               -- automatic email → automation_log.id
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, step_number)   -- one touch per step per enrollment
);

CREATE INDEX IF NOT EXISTS campaign_touch_enrollment_idx
  ON public.campaign_touch (enrollment_id);
CREATE INDEX IF NOT EXISTS campaign_touch_campaign_idx
  ON public.campaign_touch (campaign_id);
CREATE INDEX IF NOT EXISTS campaign_touch_lead_idx
  ON public.campaign_touch (lead_id);
-- The scheduler's hot query: due touches, oldest-first, within a status.
CREATE INDEX IF NOT EXISTS campaign_touch_due_idx
  ON public.campaign_touch (status, eligible_at);

CREATE TRIGGER update_campaign_touch_updated_at
  BEFORE UPDATE ON public.campaign_touch
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.campaign_touch ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view campaign touch"
  ON public.campaign_touch FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_touch.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
  ));

CREATE POLICY "Members can manage campaign touch"
  ON public.campaign_touch FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_touch.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_touch.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
  ));

CREATE POLICY "Service role full access on campaign_touch"
  ON public.campaign_touch FOR ALL TO service_role
  USING (true) WITH CHECK (true);
