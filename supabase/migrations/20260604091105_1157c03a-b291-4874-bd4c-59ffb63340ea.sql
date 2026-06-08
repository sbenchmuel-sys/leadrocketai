CREATE TABLE IF NOT EXISTS public.campaign_collateral (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  collateral_type text NOT NULL CHECK (collateral_type IN ('one_pager', 'walkthrough')),
  variant_group text,
  title text,
  body text,
  is_edited boolean NOT NULL DEFAULT false,
  attached_step_number integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS campaign_collateral_unique
  ON public.campaign_collateral (campaign_id, collateral_type, COALESCE(variant_group, ''));

CREATE INDEX IF NOT EXISTS campaign_collateral_campaign_idx
  ON public.campaign_collateral (campaign_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaign_collateral TO authenticated;
GRANT ALL ON public.campaign_collateral TO service_role;

CREATE TRIGGER update_campaign_collateral_updated_at
  BEFORE UPDATE ON public.campaign_collateral
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.campaign_collateral ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view campaign collateral"
  ON public.campaign_collateral FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_collateral.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
  ));

CREATE POLICY "Members can manage campaign collateral"
  ON public.campaign_collateral FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_collateral.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_collateral.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
  ));

CREATE POLICY "Service role full access on campaign_collateral"
  ON public.campaign_collateral FOR ALL TO service_role
  USING (true) WITH CHECK (true);