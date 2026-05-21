-- ============================================================
-- mark_action_handled — atomic RPC for the Queue UI's "handled"
-- and "undo" flows (PR C, prep for PR D).
--
-- Today the Dashboard's PriorityActions uses two unrelated paths:
--   • `dismissLeadAction(leadId, snoozeDays)`  → SELECT ... UPDATE
--     sets `action_dismissed_at = now + N days`, clears action_*.
--   • `setLeadPermanentDismiss(leadId, true)`  → SELECT-then-UPDATE
--     sets `action_permanently_dismissed = true`, clears action_*.
--
-- Both are two-step (SELECT for snapshot/undo, then UPDATE), which
-- means a concurrent sync that re-derives the lead between the SELECT
-- and the UPDATE can land an inconsistent snapshot. They also don't
-- compose: a "Dismissed" lead has no snooze timestamp, so the
-- syncEngine re-arm gate `dismissedAt > 0` never fires for it (the
-- "permanent-dismiss-without-snooze re-arm trap" tracked in
-- KNOWN_ISSUES.md).
--
-- This RPC consolidates both into one server-side atomic operation:
--   1. Capture the previous action_* state into a JSONB snapshot.
--   2. Set action_dismissed_at = now() ALWAYS (closes the re-arm
--      trap), and action_permanently_dismissed = p_permanent.
--   3. Clear needs_action / next_action_* / action_reason_code.
--   4. Return the snapshot for the caller to keep in an Undo toast.
--
-- For Undo: pass `p_restore` = the snapshot returned by the dismiss
-- call. The function detects this mode (restore IS NOT NULL) and
-- writes the snapshot values back atomically; the boolean and
-- permanent parameters are ignored in that mode.
--
-- Authorization: workspace-membership check via the
-- `is_workspace_member` SECURITY DEFINER helper, same shape as
-- `set_timeline_followup_state`.
-- ============================================================

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
  -- Atomically resolve workspace + snapshot in one read.
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
    -- UNDO mode: write snapshot values back.
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
    -- DISMISS mode: clear action_*, stamp dismissal columns.
    -- action_dismissed_at is set unconditionally so the syncEngine's
    -- `dismissedAt > 0` re-arm gate works for both snoozed AND
    -- permanently-dismissed leads (closes the trap documented in
    -- KNOWN_ISSUES.md).
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
  'Atomically mark a lead''s action as handled (or undo via p_restore). Returns the pre-update snapshot as JSONB for Undo toasts. Workspace-scoped via is_workspace_member. See migration header for full contract.';
