
-- ═══════════════════════════════════════════════
-- Structured campaign storage: campaigns + campaign_steps
-- ═══════════════════════════════════════════════

-- Campaign step type enum
CREATE TYPE public.campaign_step_type AS ENUM (
  'intro', 'followup', 'value_add', 'breakup', 'nurture', 're_engagement'
);

-- Campaign motion enum
CREATE TYPE public.campaign_motion AS ENUM (
  'outbound_prospecting', 'nurture', 'inbound_response', 'post_meeting', 'closing', 're_engagement'
);

-- ── Campaigns table ─────────────────────────────────────────────────
CREATE TABLE public.campaigns (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  motion public.campaign_motion NOT NULL DEFAULT 'outbound_prospecting',
  default_channel TEXT NOT NULL DEFAULT 'email',
  include_meeting_cta BOOLEAN NOT NULL DEFAULT false,
  global_instructions TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Campaign steps table ────────────────────────────────────────────
CREATE TABLE public.campaign_steps (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL CHECK (step_number >= 1 AND step_number <= 10),
  step_type public.campaign_step_type NOT NULL DEFAULT 'intro',
  channel TEXT NOT NULL DEFAULT 'email',
  framework TEXT,
  objective TEXT,
  cta_type TEXT NOT NULL DEFAULT 'question',
  max_word_count INTEGER,
  hard_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  generation_hints JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_instructions TEXT,
  delay_days INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  variant_group TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, step_number)
);

-- ── Link campaigns to leads ─────────────────────────────────────────
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES public.campaigns(id) ON DELETE SET NULL;

-- ── Indexes ─────────────────────────────────────────────────────────
CREATE INDEX idx_campaigns_workspace ON public.campaigns(workspace_id);
CREATE INDEX idx_campaign_steps_campaign ON public.campaign_steps(campaign_id);
CREATE INDEX idx_leads_campaign ON public.leads(campaign_id) WHERE campaign_id IS NOT NULL;

-- ── RLS ─────────────────────────────────────────────────────────────
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_steps ENABLE ROW LEVEL SECURITY;

-- Campaigns: workspace members can view, admins can manage
CREATE POLICY "Workspace members can view campaigns"
  ON public.campaigns FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace admins can manage campaigns"
  ON public.campaigns FOR ALL TO authenticated
  USING (is_workspace_admin(workspace_id, auth.uid()))
  WITH CHECK (is_workspace_admin(workspace_id, auth.uid()));

-- Service role full access
CREATE POLICY "Service role full access on campaigns"
  ON public.campaigns FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Campaign steps: inherit access from parent campaign
CREATE POLICY "Members can view campaign steps"
  ON public.campaign_steps FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_steps.campaign_id
    AND is_workspace_member(c.workspace_id, auth.uid())
  ));

CREATE POLICY "Admins can manage campaign steps"
  ON public.campaign_steps FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_steps.campaign_id
    AND is_workspace_admin(c.workspace_id, auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_steps.campaign_id
    AND is_workspace_admin(c.workspace_id, auth.uid())
  ));

CREATE POLICY "Service role full access on campaign_steps"
  ON public.campaign_steps FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ── Updated_at trigger ──────────────────────────────────────────────
CREATE TRIGGER update_campaigns_updated_at
  BEFORE UPDATE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_campaign_steps_updated_at
  BEFORE UPDATE ON public.campaign_steps
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
