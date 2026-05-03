-- 20260503140000_lead_groups_and_partners.sql
--
-- Phase 2 of the deals work — multi-stakeholder support without a CRM.
--
-- Two concepts, two storage shapes:
--
-- 1) STAKEHOLDER GROUPS (intra-company, 1:N)
--    Multiple leads at the same company collaborating on one deal share a
--    `lead_groups` row. One member is designated as `champion_lead_id`.
--    Stakeholders ARE leads (they have email/automation/sequences) — they
--    just gain a `group_id` pointer to anchor the deal view.
--
-- 2) PARTNER LINKS (cross-deal, M:N)
--    Third-party people (introducers, integrators, advisors) who span
--    multiple deals. Stored as rows in the existing `contacts` table
--    (often with `lead_id IS NULL` because they're not leads). Linked to
--    one or many groups via `group_partners`. Editing the contact once
--    updates everywhere.
--
-- Integrity model:
--   - A lead's `group_id` is nullable (default = solo lead).
--   - `champion_lead_id` MUST reference a lead with the same group_id and
--     workspace. Enforced by a deferrable constraint trigger so multi-step
--     create flows work within one transaction.
--   - When the last lead leaves a group, the group auto-deletes.
--   - When the champion is removed from the group, `champion_lead_id` is
--     cleared (the UI then prompts the user to pick a new champion).

-- ============================================
-- 1. lead_groups
-- ============================================
CREATE TABLE public.lead_groups (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  champion_lead_id    uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  group_name          text,
  created_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.lead_groups ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_lead_groups_workspace ON public.lead_groups(workspace_id);
CREATE INDEX idx_lead_groups_champion  ON public.lead_groups(champion_lead_id) WHERE champion_lead_id IS NOT NULL;

CREATE TRIGGER update_lead_groups_updated_at
  BEFORE UPDATE ON public.lead_groups
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.lead_groups IS
  'Stakeholder group: multiple leads at the same company on one deal, anchored by a champion lead.';
COMMENT ON COLUMN public.lead_groups.champion_lead_id IS
  'The primary point-of-contact for this deal. Must be a member (leads.group_id = this group). Nullable transiently when the previous champion is removed before a replacement is chosen.';
COMMENT ON COLUMN public.lead_groups.group_name IS
  'Free-text label, usually the company name. Defaults to the champion''s company on creation; user-editable.';

-- RLS: workspace members can manage groups in their workspace
CREATE POLICY "Workspace members can view lead groups"
  ON public.lead_groups FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can create lead groups"
  ON public.lead_groups FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can update lead groups"
  ON public.lead_groups FOR UPDATE
  USING (public.is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace members can delete lead groups"
  ON public.lead_groups FOR DELETE
  USING (public.is_workspace_member(workspace_id, auth.uid()));

-- ============================================
-- 2. leads.group_id
-- ============================================
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.lead_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leads_group_id
  ON public.leads(group_id)
  WHERE group_id IS NOT NULL;

COMMENT ON COLUMN public.leads.group_id IS
  'Stakeholder group this lead belongs to. NULL = solo lead (the default).';

-- ============================================
-- 3. group_partners (M:N to contacts)
-- ============================================
CREATE TABLE public.group_partners (
  group_id            uuid NOT NULL REFERENCES public.lead_groups(id) ON DELETE CASCADE,
  contact_id          uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  role_note           text,
  added_by_user_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  added_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, contact_id)
);

ALTER TABLE public.group_partners ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_group_partners_contact ON public.group_partners(contact_id);

COMMENT ON TABLE public.group_partners IS
  'Many-to-many: partners (contacts) can be linked to many groups. Reuses the existing contacts table so a partner is one record across the system.';
COMMENT ON COLUMN public.group_partners.role_note IS
  'Free text: "introduced via Stuart", "tech advisor", "channel partner", etc.';

-- RLS: must be a member of the group's workspace
CREATE POLICY "Workspace members can view group partners"
  ON public.group_partners FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.lead_groups lg
      WHERE lg.id = group_partners.group_id
        AND public.is_workspace_member(lg.workspace_id, auth.uid())
    )
  );

CREATE POLICY "Workspace members can create group partners"
  ON public.group_partners FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.lead_groups lg
      WHERE lg.id = group_partners.group_id
        AND public.is_workspace_member(lg.workspace_id, auth.uid())
    )
  );

CREATE POLICY "Workspace members can update group partners"
  ON public.group_partners FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.lead_groups lg
      WHERE lg.id = group_partners.group_id
        AND public.is_workspace_member(lg.workspace_id, auth.uid())
    )
  );

CREATE POLICY "Workspace members can delete group partners"
  ON public.group_partners FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.lead_groups lg
      WHERE lg.id = group_partners.group_id
        AND public.is_workspace_member(lg.workspace_id, auth.uid())
    )
  );

-- ============================================
-- 4. Integrity triggers
-- ============================================

-- 4a. Champion must be a member of its own group, in the same workspace.
-- DEFERRED so the multi-step create flow inside one transaction is allowed:
--   BEGIN;
--     INSERT INTO lead_groups (..., champion_lead_id = X);
--     UPDATE leads SET group_id = new_group_id WHERE id = X;
--   COMMIT;  -- check fires here, both sides exist
CREATE OR REPLACE FUNCTION public.validate_lead_group_champion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.champion_lead_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.leads
      WHERE id = NEW.champion_lead_id
        AND group_id = NEW.id
        AND workspace_id = NEW.workspace_id
    ) THEN
      RAISE EXCEPTION 'Champion lead % is not a member of group % (or wrong workspace)', NEW.champion_lead_id, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER lead_groups_validate_champion
  AFTER INSERT OR UPDATE OF champion_lead_id ON public.lead_groups
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_lead_group_champion();

-- 4b. When a lead leaves a group (group_id changes/cleared, or lead is deleted),
-- clear champion if the lead was champion, and delete the group if it becomes empty.
CREATE OR REPLACE FUNCTION public.cleanup_lead_group_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_group_id uuid;
  v_lead_id uuid;
  v_member_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old_group_id := OLD.group_id;
    v_lead_id := OLD.id;
  ELSE -- UPDATE
    IF OLD.group_id IS NOT DISTINCT FROM NEW.group_id THEN
      RETURN NEW; -- nothing changed
    END IF;
    v_old_group_id := OLD.group_id;
    v_lead_id := OLD.id;
  END IF;

  IF v_old_group_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- If this lead was the champion of the old group, clear champion
  UPDATE public.lead_groups
  SET champion_lead_id = NULL
  WHERE id = v_old_group_id
    AND champion_lead_id = v_lead_id;

  -- Count remaining members
  SELECT COUNT(*) INTO v_member_count
  FROM public.leads
  WHERE group_id = v_old_group_id;

  -- Empty group? Delete it (cascades to group_partners)
  IF v_member_count = 0 THEN
    DELETE FROM public.lead_groups WHERE id = v_old_group_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER leads_group_membership_cleanup_update
  AFTER UPDATE OF group_id ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.cleanup_lead_group_membership();

CREATE TRIGGER leads_group_membership_cleanup_delete
  AFTER DELETE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.cleanup_lead_group_membership();

-- ============================================
-- 5. Helper RPC: create a group with a champion atomically
-- ============================================
-- The frontend cannot easily wrap multiple statements in one transaction via
-- supabase-js. This SECURITY DEFINER function does the safe sequence:
--   1) Verify caller is a member of the lead's workspace.
--   2) INSERT INTO lead_groups (champion_lead_id NULL, default name from company).
--   3) UPDATE leads.group_id = new_group_id WHERE id = champion lead.
--   4) UPDATE lead_groups.champion_lead_id = champion lead id.
-- The deferred constraint trigger validates at function-end (statement-level
-- transaction boundary), so steps 2–4 succeed as a unit.
CREATE OR REPLACE FUNCTION public.create_lead_group_with_champion(
  p_champion_lead_id uuid,
  p_group_name text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id uuid;
  v_company text;
  v_existing_group_id uuid;
  v_group_id uuid;
  v_user_id uuid;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT workspace_id, company, group_id
  INTO v_workspace_id, v_company, v_existing_group_id
  FROM public.leads
  WHERE id = p_champion_lead_id;

  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Lead % not found', p_champion_lead_id USING ERRCODE = '42704';
  END IF;

  IF NOT public.is_workspace_member(v_workspace_id, v_user_id) THEN
    RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = '42501';
  END IF;

  IF v_existing_group_id IS NOT NULL THEN
    RAISE EXCEPTION 'Lead is already in group %', v_existing_group_id USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.lead_groups (workspace_id, group_name, created_by_user_id)
  VALUES (
    v_workspace_id,
    COALESCE(NULLIF(trim(p_group_name), ''), v_company),
    v_user_id
  )
  RETURNING id INTO v_group_id;

  UPDATE public.leads
  SET group_id = v_group_id
  WHERE id = p_champion_lead_id;

  UPDATE public.lead_groups
  SET champion_lead_id = p_champion_lead_id
  WHERE id = v_group_id;

  RETURN v_group_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_lead_group_with_champion(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.create_lead_group_with_champion IS
  'Atomically creates a lead_group with the given lead as champion. Use from the frontend instead of multi-step inserts to avoid race conditions and respect the deferred champion-membership constraint.';

-- ============================================
-- 6. Helper RPC: swap the champion within an existing group
-- ============================================
CREATE OR REPLACE FUNCTION public.set_lead_group_champion(
  p_group_id uuid,
  p_new_champion_lead_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id uuid;
  v_user_id uuid;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT workspace_id INTO v_workspace_id
  FROM public.lead_groups
  WHERE id = p_group_id;

  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Group % not found', p_group_id USING ERRCODE = '42704';
  END IF;

  IF NOT public.is_workspace_member(v_workspace_id, v_user_id) THEN
    RAISE EXCEPTION 'Not a member of this workspace' USING ERRCODE = '42501';
  END IF;

  -- The deferred trigger validates membership; we just attempt the update.
  UPDATE public.lead_groups
  SET champion_lead_id = p_new_champion_lead_id
  WHERE id = p_group_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_lead_group_champion(uuid, uuid) TO authenticated;
