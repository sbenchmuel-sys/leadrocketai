-- ═══════════════════════════════════════════════════════════════════
-- Editable cadence on the saved-draft detail page — atomic, reconciling
-- step-replace RPC.
--
-- Today's write path (replaceCampaignSteps) only delete-renumber-inserts
-- campaign_steps. But two dependent tables are keyed by step_number, NOT by a
-- step id, so renumbering steps silently mis-points or orphans them:
--   • campaign_step_content  — the generated/edited per-touch copy
--                              (campaign_id, step_number, variant_group).
--   • campaign_collateral.attached_step_number — the "offer with touch N" link.
-- This RPC replaces the steps AND reconciles both, atomically, in one
-- transaction so a renumber can never leave copy/links pointing at the wrong
-- step (a hard product invariant).
--
-- Reconciliation rule (decided up front — "preserve & remap, drop removed"):
--   • A SURVIVING step (its prior number is carried in orig_step_number) keeps
--     its copy/links, moved to the step's new number — INCLUDING rep edits
--     (is_edited stays true), picked options, and every industry variant row.
--   • A REMOVED step's copy is DELETED and its collateral links fall back to
--     campaign-level (attached_step_number → NULL; the asset itself is kept).
--   • An INSERTED step (orig_step_number IS NULL) starts with NO copy — the rep
--     regenerates it with the existing "Build the messages" flow. We never call
--     the AI here and never send anything.
--
-- Safety — structural edits are DRAFT-ONLY:
--   The function REFUSES any campaign that is not status='draft', or that
--   already has ANY campaign_enrollment / campaign_touch row. Live, sending
--   campaigns pre-create their full per-lead touch schedule with step_number
--   baked in and the cadence engine advances by step_number lookups —
--   renumbering under a live enrollment would corrupt in-flight sends. So we
--   never touch one: today's read-only behavior for active/paused/completed
--   campaigns is preserved server-side, not just hidden in the UI.
--
-- SECURITY DEFINER + explicit is_workspace_member gate (RLS is bypassed inside
-- a DEFINER function) — mirrors get_campaign_scorecard / set_timeline_followup_state.
-- ═══════════════════════════════════════════════════════════════════

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
  -- ── Resolve campaign + authorize (fail closed) ──
  SELECT workspace_id, status INTO v_workspace, v_status
  FROM public.campaigns WHERE id = _campaign_id;
  IF v_workspace IS NULL THEN
    RAISE EXCEPTION 'campaign not found' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_workspace_member(v_workspace, auth.uid()) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- ── Structural edits are draft-only. Preserve read-only for live campaigns. ──
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'structural edits are only allowed on a draft campaign'
      USING ERRCODE = '42501';
  END IF;

  -- Defence in depth: a draft should have no cadence rows, but if any exist,
  -- renumbering would corrupt the pre-laid-out per-lead touch schedule.
  IF EXISTS (SELECT 1 FROM public.campaign_enrollment WHERE campaign_id = _campaign_id)
     OR EXISTS (SELECT 1 FROM public.campaign_touch WHERE campaign_id = _campaign_id) THEN
    RAISE EXCEPTION 'cannot edit steps: this campaign already has enrolled people'
      USING ERRCODE = '42501';
  END IF;

  -- ── Validate input shape / size (campaign_steps.step_number CHECK is 1..10). ──
  IF _steps IS NULL OR jsonb_typeof(_steps) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'steps must be a JSON array';
  END IF;
  SELECT count(*) INTO v_count FROM jsonb_array_elements(_steps);
  IF v_count > 10 THEN
    RAISE EXCEPTION 'too many steps (max 10)';
  END IF;

  -- ── Build the old→new step_number map for SURVIVING steps ──
  -- (orig_step_number present = this touch existed before; its new number is its
  -- 1-based position in the edited array.)
  CREATE TEMP TABLE _map ON COMMIT DROP AS
  SELECT (elem->>'orig_step_number')::int AS old_num,
         ord::int                          AS new_num
  FROM jsonb_array_elements(_steps) WITH ORDINALITY AS t(elem, ord)
  WHERE elem->>'orig_step_number' IS NOT NULL;

  -- Guard against a malformed payload that reuses an orig_step_number twice
  -- (would make the remap ambiguous). Distinct survivors only.
  IF (SELECT count(*) FROM _map) <> (SELECT count(DISTINCT old_num) FROM _map) THEN
    RAISE EXCEPTION 'duplicate orig_step_number in payload';
  END IF;

  -- ── Reconcile campaign_step_content (keyed by step_number) ──
  -- 1) Drop copy for removed steps (and any pre-existing orphan rows whose
  --    number no longer maps to a surviving step).
  DELETE FROM public.campaign_step_content sc
  WHERE sc.campaign_id = _campaign_id
    AND sc.step_number NOT IN (SELECT old_num FROM _map);
  -- 2) Renumber survivors to their new number. Two-phase via a negative offset
  --    so we never transiently collide on the (campaign_id, step_number,
  --    COALESCE(variant_group,'')) unique index mid-swap (e.g. 2→1 while 1→2).
  --    step_number has no CHECK on this table, so negatives are safe parking.
  UPDATE public.campaign_step_content sc
     SET step_number = -sc.step_number
  WHERE sc.campaign_id = _campaign_id
    AND sc.step_number IN (SELECT old_num FROM _map);
  UPDATE public.campaign_step_content sc
     SET step_number = m.new_num
  FROM _map m
  WHERE sc.campaign_id = _campaign_id
    AND sc.step_number = -m.old_num;

  -- ── Reconcile campaign_collateral.attached_step_number ──
  -- The unique index does NOT include attached_step_number, so a single direct
  -- UPDATE is collision-safe. Removed-step links fall back to campaign-level
  -- (NULL) — the collateral asset itself is never deleted.
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

  -- ── Replace the steps themselves (delete-renumber-insert, like the existing
  --    write path, but inside this same transaction). New step_number = 1..N by
  --    array position. Columns with table defaults (framework, objective,
  --    max_word_count, hard_rules, generation_hints) are intentionally omitted. ──
  DELETE FROM public.campaign_steps WHERE campaign_id = _campaign_id;

  INSERT INTO public.campaign_steps
    (campaign_id, step_number, step_type, channel, cta_type, delay_days,
     custom_instructions, active, variant_group, include_meeting_cta)
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
         ELSE NULL END
  FROM jsonb_array_elements(_steps) WITH ORDINALITY AS t(elem, ord);
END;
$$;

-- Least privilege: drop the implicit PUBLIC execute, grant only to signed-in
-- users. The in-function gate fail-closes for a null auth.uid() anyway.
REVOKE EXECUTE ON FUNCTION public.replace_campaign_steps_reconciled(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replace_campaign_steps_reconciled(uuid, jsonb) TO authenticated;
