-- ═══════════════════════════════════════════════
-- Campaign foundation (Outreach Unit A)
-- Additive only. Does NOT change behavior for leads that are not
-- enrolled in a campaign. No edge function → no config.toml change.
-- Does NOT touch interactions / lead_timeline_items or
-- automation_log / automation_logs.
-- ═══════════════════════════════════════════════

-- ── 1. New campaign columns ─────────────────────────────────────────
-- campaign_type: General (one set of content for everyone) vs Industry
--   (per-industry step variants via campaign_steps.variant_group — added
--   in Unit B; Unit A stores the base/General steps with variant_group NULL).
-- status: a campaign is a living draft until later units enroll + send.
-- knowledge_ref: lightweight pointer to an attached knowledge file; actual
--   ingestion/search wiring lands in Unit B.
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS campaign_type TEXT NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS knowledge_ref TEXT;

ALTER TABLE public.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_campaign_type_check;
ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_campaign_type_check
  CHECK (campaign_type IN ('general', 'industry'));

ALTER TABLE public.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_status_check;
ALTER TABLE public.campaigns
  ADD CONSTRAINT campaigns_status_check
  CHECK (status IN ('draft', 'active', 'paused', 'completed'));

-- ── 2. Relax management RLS: admin → member ─────────────────────────
-- Every rep builds their own outreaches. Workspace isolation is preserved
-- (is_workspace_member); only the admin-only restriction is lifted.
-- The existing member SELECT policy and service-role policy are unchanged.
DROP POLICY IF EXISTS "Workspace admins can manage campaigns" ON public.campaigns;
CREATE POLICY "Workspace members can manage campaigns"
  ON public.campaigns FOR ALL TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Admins can manage campaign steps" ON public.campaign_steps;
CREATE POLICY "Members can manage campaign steps"
  ON public.campaign_steps FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_steps.campaign_id
    AND is_workspace_member(c.workspace_id, auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_steps.campaign_id
    AND is_workspace_member(c.workspace_id, auth.uid())
  ));

-- ── 3. Workspace-level do-not-contact (suppression) list ────────────
-- Separate from the per-lead leads.unsubscribed flag (which stays as-is).
-- Unit A: storage + CRUD + UI only. Enforcement (read-before-send) is an
-- explicit Unit B deliverable, gated to the send path.
CREATE TABLE IF NOT EXISTS public.campaign_suppression_list (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'domain')),
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, value)
);

CREATE INDEX IF NOT EXISTS idx_suppression_workspace
  ON public.campaign_suppression_list(workspace_id);

ALTER TABLE public.campaign_suppression_list ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view suppression list"
  ON public.campaign_suppression_list FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Members can manage suppression list"
  ON public.campaign_suppression_list FOR ALL TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Service role full access on suppression list"
  ON public.campaign_suppression_list FOR ALL TO service_role
  USING (true) WITH CHECK (true);
