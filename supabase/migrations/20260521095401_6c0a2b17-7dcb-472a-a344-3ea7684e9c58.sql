CREATE OR REPLACE FUNCTION public.mark_action_handled(
  p_lead_id   uuid,
  p_permanent boolean DEFAULT false,
  p_restore   jsonb   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id uuid;
  v_snapshot     jsonb;
BEGIN
  SELECT
    workspace_id,
    jsonb_build_object(
      'needs_action',                  needs_action,
      'next_action_key',               next_action_key,
      'next_action_label',             next_action_label,
      'action_reason_code',            action_reason_code,
      'action_dismissed_at',           action_dismissed_at,
      'action_permanently_dismissed',  action_permanently_dismissed
    )
  INTO v_workspace_id, v_snapshot
  FROM public.leads
  WHERE id = p_lead_id;

  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'lead % not found', p_lead_id;
  END IF;

  IF NOT public.is_workspace_member(v_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'permission denied for workspace %', v_workspace_id;
  END IF;

  IF p_restore IS NOT NULL THEN
    UPDATE public.leads SET
      needs_action                 = COALESCE((p_restore->>'needs_action')::boolean, false),
      next_action_key              = NULLIF(p_restore->>'next_action_key', ''),
      next_action_label            = NULLIF(p_restore->>'next_action_label', ''),
      action_reason_code           = NULLIF(p_restore->>'action_reason_code', ''),
      action_dismissed_at          = NULLIF(p_restore->>'action_dismissed_at', '')::timestamptz,
      action_permanently_dismissed = COALESCE((p_restore->>'action_permanently_dismissed')::boolean, false),
      last_activity_at             = now()
    WHERE id = p_lead_id;
  ELSE
    UPDATE public.leads SET
      needs_action                 = false,
      next_action_key              = NULL,
      next_action_label            = NULL,
      action_reason_code           = NULL,
      action_dismissed_at          = now(),
      action_permanently_dismissed = p_permanent,
      last_activity_at             = now()
    WHERE id = p_lead_id;
  END IF;

  RETURN v_snapshot;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_action_handled(uuid, boolean, jsonb)
  TO authenticated;

COMMENT ON FUNCTION public.mark_action_handled(uuid, boolean, jsonb) IS
  'Atomically mark a lead''s action as handled (or undo via p_restore). Returns the pre-update snapshot as JSONB for Undo toasts. Workspace-scoped via is_workspace_member.';

CREATE OR REPLACE FUNCTION public.get_latest_intents_for_leads(
  p_lead_ids uuid[]
)
RETURNS TABLE (
  lead_id uuid,
  intent  text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT DISTINCT ON (lti.lead_id)
    lti.lead_id,
    lti.intent
  FROM public.lead_timeline_items lti
  WHERE lti.lead_id = ANY(p_lead_ids)
    AND lti.event_type = 'email_inbound'
    AND lti.intent IS NOT NULL
    AND public.is_workspace_member(lti.workspace_id, auth.uid())
  ORDER BY lti.lead_id, lti.occurred_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_latest_intents_for_leads(uuid[])
  TO authenticated;

COMMENT ON FUNCTION public.get_latest_intents_for_leads(uuid[]) IS
  'Return the latest inbound intent per requested lead. Authorized via is_workspace_member; unauthorized lead IDs are silently filtered out.';