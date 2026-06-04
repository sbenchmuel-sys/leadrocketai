-- ============================================================================
-- Outreach Unit B (Phase 2) — generated per-touch content store.
--
-- One row per (campaign × step_number × variant_group). variant_group is the
-- lead industry for an Industry campaign; NULL means the General / fallback
-- variant used for everyone (and for blank-industry leads). This is where the
-- orchestrator (generateCampaignContent.ts) saves the AI-generated, rep-editable
-- script for each touch — kept SEPARATE from campaign_steps (the cadence/structure)
-- so editing copy never disturbs the sequence definition.
--
-- Channel-shaped columns (only the relevant one(s) are populated per touch):
--   email → subject + body
--   call  → talking_points (+ voicemail_script for the no-answer leave-behind)
--   sms   → sms_text
-- options_json holds the "couple of options" the rep can pick between (2
-- sequential ai_task generations); selected_option is the chosen index.
-- is_edited locks a touch: once true, only an explicit per-touch Rewrite
-- regenerates it — picking an option or regenerating siblings must never wipe it.
--
-- RLS mirrors campaign_steps exactly: workspace MEMBERS (via the parent
-- campaign's workspace) manage; service_role full access.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.campaign_step_content (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  step_number integer NOT NULL,
  variant_group text,                       -- industry label; NULL = General/fallback
  subject text,                             -- email
  body text,                                -- email
  talking_points text,                      -- call
  voicemail_script text,                    -- call (no-answer leave-behind)
  sms_text text,                            -- sms
  options_json jsonb,                       -- [{subject?, body?, talking_points?, voicemail_script?, sms_text?}, ...]
  selected_option integer,                  -- index into options_json the rep picked
  is_edited boolean NOT NULL DEFAULT false, -- rep-locked: only per-touch Rewrite regenerates
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- NULL-safe uniqueness: one row per (campaign, step, variant). COALESCE so the
-- General variant (variant_group IS NULL) collapses to a single row per step
-- (a plain UNIQUE treats NULLs as distinct and would allow duplicates).
CREATE UNIQUE INDEX IF NOT EXISTS campaign_step_content_unique
  ON public.campaign_step_content (campaign_id, step_number, COALESCE(variant_group, ''));

CREATE INDEX IF NOT EXISTS campaign_step_content_campaign_idx
  ON public.campaign_step_content (campaign_id);

CREATE TRIGGER update_campaign_step_content_updated_at
  BEFORE UPDATE ON public.campaign_step_content
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.campaign_step_content ENABLE ROW LEVEL SECURITY;

-- Members of the parent campaign's workspace can read.
CREATE POLICY "Members can view campaign step content"
  ON public.campaign_step_content FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.campaigns c
    WHERE c.id = campaign_step_content.campaign_id
      AND public.is_workspace_member(c.workspace_id, auth.uid())
  ));

-- Members of the parent campaign's workspace can write (mirrors the Unit A
-- relaxation of campaign_steps from admin → member: every rep builds their own).
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
