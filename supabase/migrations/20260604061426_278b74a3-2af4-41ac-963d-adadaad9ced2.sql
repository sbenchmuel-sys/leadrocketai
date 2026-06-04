CREATE TABLE IF NOT EXISTS public.campaign_step_content (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  step_number integer NOT NULL,
  variant_group text,
  subject text,
  body text,
  talking_points text,
  voicemail_script text,
  sms_text text,
  options_json jsonb,
  selected_option integer,
  is_edited boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaign_step_content TO authenticated;
GRANT ALL ON public.campaign_step_content TO service_role;

CREATE UNIQUE INDEX IF NOT EXISTS campaign_step_content_unique
  ON public.campaign_step_content (campaign_id, step_number, COALESCE(variant_group, ''));

CREATE INDEX IF NOT EXISTS campaign_step_content_campaign_idx
  ON public.campaign_step_content (campaign_id);

DROP TRIGGER IF EXISTS update_campaign_step_content_updated_at ON public.campaign_step_content;
CREATE TRIGGER update_campaign_step_content_updated_at
  BEFORE UPDATE ON public.campaign_step_content
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.campaign_step_content ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view campaign step content"
  ON public.campaign_step_content FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_step_content.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
  ));

CREATE POLICY "Members can manage campaign step content"
  ON public.campaign_step_content FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_step_content.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_step_content.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
  ));

CREATE POLICY "Service role full access on campaign_step_content"
  ON public.campaign_step_content FOR ALL TO service_role
  USING (true) WITH CHECK (true);