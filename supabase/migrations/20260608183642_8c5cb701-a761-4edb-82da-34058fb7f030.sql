-- ═══════════════════════════════════════════════════════════════════
-- Outreach Unit C (PR 1) — enrollment + per-touch cadence schema.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS send_mode TEXT NOT NULL DEFAULT 'review';

ALTER TABLE public.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_send_mode_check;
ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_send_mode_check
  CHECK (send_mode IN ('review', 'automatic'));

ALTER TABLE public.workspace_automation_settings
  ADD COLUMN IF NOT EXISTS cold_auto_send_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS cold_outreach_postal_address TEXT;

COMMENT ON COLUMN public.workspaces.cold_outreach_postal_address IS
  'User-entered company mailing address for the CAN-SPAM footer on cold outreach emails. NEVER AI-populated. When blank, cold sending (automatic and review) is blocked.';

-- ── campaign_enrollment ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.campaign_enrollment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'active', 'replied', 'paused', 'completed', 'stopped')),
  current_step_number integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, lead_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaign_enrollment TO authenticated;
GRANT ALL ON public.campaign_enrollment TO service_role;

CREATE INDEX IF NOT EXISTS campaign_enrollment_campaign_idx
  ON public.campaign_enrollment (campaign_id);
CREATE INDEX IF NOT EXISTS campaign_enrollment_lead_idx
  ON public.campaign_enrollment (lead_id);
CREATE INDEX IF NOT EXISTS campaign_enrollment_status_idx
  ON public.campaign_enrollment (status);

CREATE UNIQUE INDEX IF NOT EXISTS campaign_enrollment_one_live_per_lead
  ON public.campaign_enrollment (lead_id)
  WHERE status IN ('scheduled', 'active', 'paused');

DROP TRIGGER IF EXISTS update_campaign_enrollment_updated_at ON public.campaign_enrollment;
CREATE TRIGGER update_campaign_enrollment_updated_at
  BEFORE UPDATE ON public.campaign_enrollment
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.campaign_enrollment ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view campaign enrollment" ON public.campaign_enrollment;
CREATE POLICY "Members can view campaign enrollment"
  ON public.campaign_enrollment FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_enrollment.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
      AND EXISTS (
        SELECT 1 FROM public.leads l
        WHERE l.id = campaign_enrollment.lead_id
          AND l.workspace_id = c.workspace_id
          AND (l.owner_user_id = auth.uid() OR public.is_workspace_admin(l.workspace_id, auth.uid()))
      )
  ));

DROP POLICY IF EXISTS "Members can manage campaign enrollment" ON public.campaign_enrollment;
CREATE POLICY "Members can manage campaign enrollment"
  ON public.campaign_enrollment FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_enrollment.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
      AND EXISTS (
        SELECT 1 FROM public.leads l
        WHERE l.id = campaign_enrollment.lead_id
          AND l.workspace_id = c.workspace_id
          AND (l.owner_user_id = auth.uid() OR public.is_workspace_admin(l.workspace_id, auth.uid()))
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_enrollment.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
      AND EXISTS (
        SELECT 1 FROM public.leads l
        WHERE l.id = campaign_enrollment.lead_id
          AND l.workspace_id = c.workspace_id
          AND (l.owner_user_id = auth.uid() OR public.is_workspace_admin(l.workspace_id, auth.uid()))
      )
  ));

DROP POLICY IF EXISTS "Service role full access on campaign_enrollment" ON public.campaign_enrollment;
CREATE POLICY "Service role full access on campaign_enrollment"
  ON public.campaign_enrollment FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── campaign_touch ──────────────────────────────────────────────────
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
  eligible_at timestamptz,
  max_age_at timestamptz,
  call_outcome text
    CHECK (call_outcome IN ('got_them', 'no_answer')),
  sent_at timestamptz,
  draft_id uuid,
  automation_log_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, step_number)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaign_touch TO authenticated;
GRANT ALL ON public.campaign_touch TO service_role;

CREATE INDEX IF NOT EXISTS campaign_touch_enrollment_idx
  ON public.campaign_touch (enrollment_id);
CREATE INDEX IF NOT EXISTS campaign_touch_campaign_idx
  ON public.campaign_touch (campaign_id);
CREATE INDEX IF NOT EXISTS campaign_touch_lead_idx
  ON public.campaign_touch (lead_id);
CREATE INDEX IF NOT EXISTS campaign_touch_due_idx
  ON public.campaign_touch (status, eligible_at);

DROP TRIGGER IF EXISTS update_campaign_touch_updated_at ON public.campaign_touch;
CREATE TRIGGER update_campaign_touch_updated_at
  BEFORE UPDATE ON public.campaign_touch
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.campaign_touch ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view campaign touch" ON public.campaign_touch;
CREATE POLICY "Members can view campaign touch"
  ON public.campaign_touch FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_touch.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
      AND EXISTS (
        SELECT 1 FROM public.leads l
        WHERE l.id = campaign_touch.lead_id
          AND l.workspace_id = c.workspace_id
          AND (l.owner_user_id = auth.uid() OR public.is_workspace_admin(l.workspace_id, auth.uid()))
      )
  ));

DROP POLICY IF EXISTS "Members can manage campaign touch" ON public.campaign_touch;
CREATE POLICY "Members can manage campaign touch"
  ON public.campaign_touch FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_touch.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
      AND EXISTS (
        SELECT 1 FROM public.leads l
        WHERE l.id = campaign_touch.lead_id
          AND l.workspace_id = c.workspace_id
          AND (l.owner_user_id = auth.uid() OR public.is_workspace_admin(l.workspace_id, auth.uid()))
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_touch.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
      AND EXISTS (
        SELECT 1 FROM public.leads l
        WHERE l.id = campaign_touch.lead_id
          AND l.workspace_id = c.workspace_id
          AND (l.owner_user_id = auth.uid() OR public.is_workspace_admin(l.workspace_id, auth.uid()))
      )
  ));

DROP POLICY IF EXISTS "Service role full access on campaign_touch" ON public.campaign_touch;
CREATE POLICY "Service role full access on campaign_touch"
  ON public.campaign_touch FOR ALL TO service_role
  USING (true) WITH CHECK (true);