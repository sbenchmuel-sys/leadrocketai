-- Campaign foundation (Outreach Unit A)

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS campaign_type TEXT NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS knowledge_ref TEXT;

ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_campaign_type_check;
ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_campaign_type_check
  CHECK (campaign_type IN ('general', 'industry'));

ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;
ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_status_check
  CHECK (status IN ('draft', 'active', 'paused', 'completed'));

UPDATE public.campaigns SET status = 'active';

DROP POLICY IF EXISTS "Workspace admins can manage campaigns" ON public.campaigns;
CREATE POLICY "Workspace members can manage campaigns"
  ON public.campaigns FOR ALL TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (is_workspace_member(workspace_id, auth.uid()));

DROP POLICY IF EXISTS "Admins can manage campaign steps" ON public.campaign_steps;
CREATE POLICY "Members can manage campaign steps"
  ON public.campaign_steps FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.campaigns c WHERE c.id = campaign_steps.campaign_id AND is_workspace_member(c.workspace_id, auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.campaigns c WHERE c.id = campaign_steps.campaign_id AND is_workspace_member(c.workspace_id, auth.uid())));

CREATE TABLE IF NOT EXISTS public.campaign_suppression_list (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'domain')),
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, value)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaign_suppression_list TO authenticated;
GRANT ALL ON public.campaign_suppression_list TO service_role;

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