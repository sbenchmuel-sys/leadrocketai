-- ============================================================================
-- Outreach Unit D — campaign collateral (AI-drafted, rep-editable).
--
-- One row per (campaign × collateral_type × variant_group). variant_group is
-- the lead industry for an Industry campaign; NULL = the General / fallback
-- variant. This holds reviewable DRAFTS (industry one-pagers, technical
-- walkthroughs) generated from the campaign's own instructions + uploaded
-- knowledge document. It is a documents/drafts feature — it does NOT send.
--
-- attached_step_number is a LIGHTWEIGHT logical link: "offer this collateral
-- when writing touch N". It is NOT a send-time MIME attachment (the providers
-- have no attachment support yet — that's Unit C). The UI labels it "linked",
-- never "attached/sent".
--
-- RLS mirrors campaign_step_content exactly: workspace MEMBERS (via the parent
-- campaign's workspace) manage; service_role full access.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.campaign_collateral (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  collateral_type text NOT NULL CHECK (collateral_type IN ('one_pager', 'walkthrough')),
  variant_group text,                       -- industry label; NULL = General/fallback
  title text,
  body text,                                -- the draft (plain text / light markdown)
  is_edited boolean NOT NULL DEFAULT false, -- rep-locked: regenerate confirms before replacing
  attached_step_number integer,             -- logical "offer with touch N"; NULL = campaign-level
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- NULL-safe uniqueness: one row per (campaign, type, variant). COALESCE so the
-- General variant (variant_group IS NULL) collapses to a single row per type.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_collateral_unique
  ON public.campaign_collateral (campaign_id, collateral_type, COALESCE(variant_group, ''));

CREATE INDEX IF NOT EXISTS campaign_collateral_campaign_idx
  ON public.campaign_collateral (campaign_id);

CREATE TRIGGER update_campaign_collateral_updated_at
  BEFORE UPDATE ON public.campaign_collateral
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.campaign_collateral ENABLE ROW LEVEL SECURITY;

-- Members of the parent campaign's workspace can read.
CREATE POLICY "Members can view campaign collateral"
  ON public.campaign_collateral FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_collateral.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
  ));

-- Members of the parent campaign's workspace can write (mirrors campaign_steps /
-- campaign_step_content: every rep builds their own).
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
