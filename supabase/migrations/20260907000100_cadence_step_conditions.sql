-- ═══════════════════════════════════════════════════════════════════
-- Outreach Sprint 3 — cadence step conditions + the LinkedIn-accepted signal.
--
-- A step can now carry a CONDITION; when the step comes due and the condition
-- isn't met, the scheduler/executor auto-skips it (with the usual timeline note
-- saying why) and the cadence moves on — instead of always running the fixed
-- sequence. Three conditions, read from signals the cadence already has:
--   linkedin_accepted  — the rep has marked the lead's LinkedIn invite accepted
--                        (leads.linkedin_connected_at, set from the Outreach card)
--   call_answered      — a call touch in this enrollment was logged "Got them"
--   no_call_answered   — no call touch in this enrollment was logged "Got them"
-- NULL = unconditional (every existing step; default for new ones).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.campaign_steps
  ADD COLUMN IF NOT EXISTS condition text;
ALTER TABLE public.campaign_steps
  DROP CONSTRAINT IF EXISTS campaign_steps_condition_check;
ALTER TABLE public.campaign_steps
  ADD CONSTRAINT campaign_steps_condition_check
  CHECK (condition IS NULL OR condition IN ('linkedin_accepted', 'call_answered', 'no_call_answered'));

COMMENT ON COLUMN public.campaign_steps.condition IS
  'Cadence branch: NULL = always run; linkedin_accepted / call_answered / no_call_answered = auto-skip the step when the signal is not there when the step comes due.';

-- The one signal that has no data source: LinkedIn has no integration (by design),
-- so the rep marks acceptance from the Outreach card. Lives on the LEAD, not the
-- enrollment — a connection outlives one outreach.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS linkedin_connected_at timestamptz;

COMMENT ON COLUMN public.leads.linkedin_connected_at IS
  'When the rep marked this lead''s LinkedIn connection request as accepted (rep-entered; no LinkedIn integration).';

-- ── replace_campaign_steps_reconciled must carry the new column ─────
-- Same body as 20260625000000_replace_campaign_steps_reconciled.sql, plus
-- `condition` in the INSERT. (The whole function is restated because
-- CREATE OR REPLACE replaces the body wholesale.)
CREATE OR REPLACE FUNCTION public.replace_campaign_steps_reconciled(
  _campaign_id uuid,
  _steps       jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace uuid;
  v_status    text;
  v_count     int;
BEGIN
  SELECT workspace_id, status INTO v_workspace, v_status
  FROM public.campaigns WHERE id = _campaign_id FOR UPDATE;
  IF v_workspace IS NULL THEN
    RAISE EXCEPTION 'campaign not found' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_workspace_member(v_workspace, auth.uid()) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'structural edits are only allowed on a draft campaign'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM public.campaign_enrollment WHERE campaign_id = _campaign_id)
     OR EXISTS (SELECT 1 FROM public.campaign_touch WHERE campaign_id = _campaign_id) THEN
    RAISE EXCEPTION 'cannot edit steps: this campaign already has enrolled people'
      USING ERRCODE = '42501';
  END IF;

  IF _steps IS NULL OR jsonb_typeof(_steps) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'steps must be a JSON array';
  END IF;
  SELECT count(*) INTO v_count FROM jsonb_array_elements(_steps);
  IF v_count > 10 THEN
    RAISE EXCEPTION 'too many steps (max 10)';
  END IF;

  CREATE TEMP TABLE _map ON COMMIT DROP AS
  SELECT (elem->>'orig_step_number')::int AS old_num,
         ord::int                          AS new_num
  FROM jsonb_array_elements(_steps) WITH ORDINALITY AS t(elem, ord)
  WHERE elem->>'orig_step_number' IS NOT NULL;

  IF (SELECT count(*) FROM _map) <> (SELECT count(DISTINCT old_num) FROM _map) THEN
    RAISE EXCEPTION 'duplicate orig_step_number in payload';
  END IF;

  DELETE FROM public.campaign_step_content sc
  WHERE sc.campaign_id = _campaign_id
    AND sc.step_number NOT IN (SELECT old_num FROM _map);
  UPDATE public.campaign_step_content sc
     SET step_number = -sc.step_number
  WHERE sc.campaign_id = _campaign_id
    AND sc.step_number IN (SELECT old_num FROM _map);
  UPDATE public.campaign_step_content sc
     SET step_number = m.new_num
  FROM _map m
  WHERE sc.campaign_id = _campaign_id
    AND sc.step_number = -m.old_num;

  UPDATE public.campaign_collateral cc
     SET attached_step_number = NULL
  WHERE cc.campaign_id = _campaign_id
    AND cc.attached_step_number IS NOT NULL
    AND cc.attached_step_number NOT IN (SELECT old_num FROM _map);
  UPDATE public.campaign_collateral cc
     SET attached_step_number = m.new_num
  FROM _map m
  WHERE cc.campaign_id = _campaign_id
    AND cc.attached_step_number = m.old_num;

  DELETE FROM public.campaign_steps WHERE campaign_id = _campaign_id;

  INSERT INTO public.campaign_steps
    (campaign_id, step_number, step_type, channel, cta_type, delay_days,
     custom_instructions, active, variant_group, include_meeting_cta, condition)
  SELECT
    _campaign_id,
    ord::int,
    COALESCE(NULLIF(elem->>'step_type', ''), 'followup')::public.campaign_step_type,
    COALESCE(NULLIF(elem->>'channel', ''), 'email'),
    COALESCE(NULLIF(elem->>'cta_type', ''), 'question'),
    COALESCE((elem->>'delay_days')::int, 0),
    NULLIF(elem->>'custom_instructions', ''),
    COALESCE((elem->>'active')::boolean, true),
    NULLIF(elem->>'variant_group', ''),
    CASE WHEN elem ? 'include_meeting_cta' AND elem->>'include_meeting_cta' IS NOT NULL
         THEN (elem->>'include_meeting_cta')::boolean
         ELSE NULL END,
    NULLIF(elem->>'condition', '')
  FROM jsonb_array_elements(_steps) WITH ORDINALITY AS t(elem, ord);

  IF EXISTS (SELECT 1 FROM public.campaign_enrollment WHERE campaign_id = _campaign_id)
     OR EXISTS (SELECT 1 FROM public.campaign_touch WHERE campaign_id = _campaign_id) THEN
    RAISE EXCEPTION 'cannot edit steps: people were enrolled while you were editing'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.replace_campaign_steps_reconciled(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replace_campaign_steps_reconciled(uuid, jsonb) TO authenticated;
