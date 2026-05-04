-- 20260504100000_timeline_followup_state.sql
CREATE TABLE public.timeline_followup_state (
  timeline_item_id    uuid PRIMARY KEY
    REFERENCES public.lead_timeline_items(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL
    REFERENCES public.workspaces(id) ON DELETE CASCADE,
  snoozed_until       timestamptz NULL,
  dismissed_at        timestamptz NULL,
  updated_by_user_id  uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_timeline_followup_state_workspace
  ON public.timeline_followup_state(workspace_id);

ALTER TABLE public.timeline_followup_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace members read followup_state"
  ON public.timeline_followup_state FOR SELECT
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "workspace members insert followup_state"
  ON public.timeline_followup_state FOR INSERT
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "workspace members update followup_state"
  ON public.timeline_followup_state FOR UPDATE
  USING (public.is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (public.is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "workspace members delete followup_state"
  ON public.timeline_followup_state FOR DELETE
  USING (public.is_workspace_member(workspace_id, auth.uid()));

CREATE OR REPLACE FUNCTION public.set_timeline_followup_state(
  p_timeline_item_id   uuid,
  p_snoozed_until      timestamptz DEFAULT NULL,
  p_dismissed_at       timestamptz DEFAULT NULL,
  p_clear_snoozed      boolean     DEFAULT FALSE,
  p_clear_dismissed    boolean     DEFAULT FALSE
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id uuid;
BEGIN
  SELECT workspace_id INTO v_workspace_id
  FROM public.lead_timeline_items
  WHERE id = p_timeline_item_id;

  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'timeline item % not found', p_timeline_item_id;
  END IF;

  IF NOT public.is_workspace_member(v_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'permission denied for workspace %', v_workspace_id;
  END IF;

  INSERT INTO public.timeline_followup_state (
    timeline_item_id, workspace_id, snoozed_until, dismissed_at,
    updated_by_user_id, updated_at
  )
  VALUES (
    p_timeline_item_id, v_workspace_id,
    CASE WHEN p_clear_snoozed   THEN NULL ELSE p_snoozed_until END,
    CASE WHEN p_clear_dismissed THEN NULL ELSE p_dismissed_at  END,
    auth.uid(), now()
  )
  ON CONFLICT (timeline_item_id) DO UPDATE SET
    snoozed_until = CASE
      WHEN p_clear_snoozed THEN NULL
      WHEN p_snoozed_until IS NOT NULL THEN p_snoozed_until
      ELSE timeline_followup_state.snoozed_until
    END,
    dismissed_at = CASE
      WHEN p_clear_dismissed THEN NULL
      WHEN p_dismissed_at IS NOT NULL THEN p_dismissed_at
      ELSE timeline_followup_state.dismissed_at
    END,
    updated_by_user_id = auth.uid(),
    updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_timeline_followup_state(
  uuid, timestamptz, timestamptz, boolean, boolean
) TO authenticated;