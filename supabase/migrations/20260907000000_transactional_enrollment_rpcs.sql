-- ═══════════════════════════════════════════════════════════════════
-- Outreach Sprint 3 (#8) — transactional enrollment + launch RPCs.
--
-- Until now "Add people" was a browser-driven sequence: stamp leads.campaign_id,
-- insert campaign_enrollment rows, re-read the step fingerprint, insert every
-- campaign_touch row (N leads × up to 10 steps), each a separate request with
-- hand-written rollback between them. A dropped connection or a closed tab in
-- the middle could leave a lead stamped-but-unscheduled, or enrolled with no
-- cadence (and a retry then skipped it as "already enrolled"). Launch had the
-- same shape: one touch UPSERT, then one UPDATE per enrollment in chunks, then
-- the status flip — three phases that could commit independently.
--
-- These two functions make each of those ONE transaction. The client still
-- owns the planning (staggered starts, business-day schedule — pure, tested
-- TypeScript in src/lib/campaignEnrollment.ts); the database owns the write.
-- Any failure anywhere rolls the whole thing back; nothing is half-done.
--
-- SECURITY DEFINER + explicit gates (RLS is bypassed inside a DEFINER function),
-- mirroring replace_campaign_steps_reconciled. Every lead-level write re-checks
-- what the table policies would have: the lead is in the campaign's workspace
-- AND owned by the caller (or the caller is a workspace admin).
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. enroll_campaign_leads ────────────────────────────────────────
-- _enrollments: JSON array of
--   { "lead_id": uuid, "started_at": timestamptz,
--     "touches": [ { "step_number": int, "channel": text,
--                    "eligible_at": timestamptz, "max_age_at": timestamptz|null } ] }
-- _step_fingerprint: stepScheduleFingerprint() of the steps the plan was built
--   from — "1:email:0|2:linkedin:1|…". Refused if the campaign's steps no longer
--   match (a concurrent draft step-edit), so touches are never written against
--   a stale numbering.
--
-- Per lead, fail-closed and SKIPPED (not aborted) when it: is unsubscribed; is
-- on the workspace do-not-contact list (email or domain); already has a row in
-- this campaign; has a live enrollment anywhere else; belongs to a different
-- campaign; or can't be claimed (cross-workspace, not owned by the caller, or
-- claimed by a concurrent enrollment). Skipping a lead only ever LOWERS the
-- planned daily email load, so the client's staggered plan stays valid.
--
-- Returns { "enrolled": [lead_id…], "skipped": [lead_id…] }.
CREATE OR REPLACE FUNCTION public.enroll_campaign_leads(
  _campaign_id      uuid,
  _step_fingerprint text,
  _enrollments      jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace   uuid;
  v_caller      uuid := auth.uid();
  v_is_admin    boolean;
  v_fingerprint text;
  v_count       int;
  v_elem        jsonb;
  v_lead_id     uuid;
  v_started_at  timestamptz;
  v_stamped     int;
  v_enr_id      uuid;
  v_enrolled    uuid[] := '{}';
  v_skipped     uuid[] := '{}';
BEGIN
  -- ── Resolve campaign + authorize (fail closed) ──
  -- FOR SHARE: serializes against replace_campaign_steps_reconciled and
  -- launch_campaign_with_schedule (both take FOR UPDATE on the campaign row), so a
  -- step renumber or a launch can't interleave with this write. Concurrent
  -- enrollments share the lock and proceed; per-lead claims below are still
  -- race-safe because each is a guarded UPDATE.
  SELECT workspace_id INTO v_workspace
  FROM public.campaigns WHERE id = _campaign_id FOR SHARE;
  IF v_workspace IS NULL THEN
    RAISE EXCEPTION 'campaign not found' USING ERRCODE = '42501';
  END IF;
  IF v_caller IS NULL OR NOT public.is_workspace_member(v_workspace, v_caller) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  v_is_admin := public.is_workspace_admin(v_workspace, v_caller);

  -- ── Step fingerprint must match what the plan was built from ──
  SELECT string_agg(step_number || ':' || channel || ':' || COALESCE(delay_days, 0), '|'
                    ORDER BY step_number)
    INTO v_fingerprint
  FROM public.campaign_steps
  WHERE campaign_id = _campaign_id AND active IS DISTINCT FROM false;
  IF v_fingerprint IS NULL THEN
    RAISE EXCEPTION 'This outreach has no active touches to schedule.';
  END IF;
  IF v_fingerprint IS DISTINCT FROM _step_fingerprint THEN
    RAISE EXCEPTION 'The outreach steps changed while you were enrolling. Please try again.'
      USING ERRCODE = '40001';
  END IF;

  -- ── Validate payload shape ──
  IF _enrollments IS NULL OR jsonb_typeof(_enrollments) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'enrollments must be a JSON array';
  END IF;
  SELECT count(*) INTO v_count FROM jsonb_array_elements(_enrollments);
  IF v_count = 0 THEN
    RETURN jsonb_build_object('enrolled', '[]'::jsonb, 'skipped', '[]'::jsonb);
  END IF;

  FOR v_elem IN SELECT * FROM jsonb_array_elements(_enrollments) LOOP
    v_lead_id    := (v_elem->>'lead_id')::uuid;
    v_started_at := (v_elem->>'started_at')::timestamptz;
    IF v_lead_id IS NULL OR v_started_at IS NULL THEN
      RAISE EXCEPTION 'each enrollment needs lead_id and started_at';
    END IF;
    IF jsonb_typeof(v_elem->'touches') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_elem->'touches') = 0 THEN
      RAISE EXCEPTION 'each enrollment needs at least one touch';
    END IF;

    -- Fail-closed gates that must hold at WRITE time, not just when the plan was
    -- previewed: opt-out, do-not-contact, already scheduled here or live elsewhere.
    IF EXISTS (
         SELECT 1 FROM public.leads l
         WHERE l.id = v_lead_id AND (
           l.unsubscribed = true
           OR EXISTS (
             SELECT 1 FROM public.campaign_suppression_list s
             WHERE s.workspace_id = v_workspace
               AND ((s.kind = 'email'  AND lower(s.value) = lower(l.email))
                 OR (s.kind = 'domain' AND lower(s.value) = lower(split_part(l.email, '@', 2))))
           )
         )
       )
       OR EXISTS (SELECT 1 FROM public.campaign_enrollment e
                  WHERE e.campaign_id = _campaign_id AND e.lead_id = v_lead_id)
       OR EXISTS (SELECT 1 FROM public.campaign_enrollment e
                  WHERE e.lead_id = v_lead_id AND e.status IN ('scheduled', 'active', 'paused'))
    THEN
      v_skipped := v_skipped || v_lead_id;
      CONTINUE;
    END IF;

    -- Claim the lead for this campaign. Guarded to the campaign's workspace, to an
    -- unassigned lead (or one already a member of THIS campaign), and to the
    -- leads table's own owner-or-admin scope — the same checks its RLS would run.
    UPDATE public.leads l
       SET campaign_id = _campaign_id
     WHERE l.id = v_lead_id
       AND l.workspace_id = v_workspace
       AND (l.campaign_id IS NULL OR l.campaign_id = _campaign_id)
       AND (l.owner_user_id = v_caller OR v_is_admin);
    GET DIAGNOSTICS v_stamped = ROW_COUNT;
    IF v_stamped = 0 THEN
      v_skipped := v_skipped || v_lead_id;
      CONTINUE;
    END IF;

    INSERT INTO public.campaign_enrollment
      (campaign_id, lead_id, status, current_step_number, started_at)
    VALUES (_campaign_id, v_lead_id, 'scheduled', 0, v_started_at)
    RETURNING id INTO v_enr_id;

    INSERT INTO public.campaign_touch
      (enrollment_id, campaign_id, lead_id, step_number, channel, status, eligible_at, max_age_at)
    SELECT v_enr_id, _campaign_id, v_lead_id,
           (t->>'step_number')::int,
           t->>'channel',
           'scheduled',
           (t->>'eligible_at')::timestamptz,
           NULLIF(t->>'max_age_at', '')::timestamptz
    FROM jsonb_array_elements(v_elem->'touches') AS t;

    v_enrolled := v_enrolled || v_lead_id;
  END LOOP;

  RETURN jsonb_build_object(
    'enrolled', to_jsonb(v_enrolled),
    'skipped',  to_jsonb(v_skipped)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enroll_campaign_leads(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enroll_campaign_leads(uuid, text, jsonb) TO authenticated;

-- ── 2. launch_campaign_with_schedule ────────────────────────────────
-- _plan: JSON array of
--   { "enrollment_id": uuid, "started_at": timestamptz,
--     "touches": [ { "step_number": int, "channel": text,
--                    "eligible_at": timestamptz, "max_age_at": timestamptz|null } ] }
-- — one entry per NOT-STARTED enrollment (current_step_number = 0), re-dated
-- from the launch moment by the client planner (planRelaunch).
--
-- In one transaction: re-write those enrollments' touch rows, set their new
-- started_at, and flip the campaign draft → active. Refuses (whole thing rolls
-- back) if the campaign isn't a draft, or if the set of not-started enrollments
-- in the database differs from the plan — people added between the client's
-- read and this call would otherwise launch on a stale "add people" schedule
-- (the BUG-011 shape). The client re-plans and retries.
--
-- Returns { "reanchored": int }.
CREATE OR REPLACE FUNCTION public.launch_campaign_with_schedule(
  _campaign_id uuid,
  _plan        jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace uuid;
  v_status    text;
  v_caller    uuid := auth.uid();
  v_planned   int;
  v_pending   int;
  v_matched   int;
  v_elem      jsonb;
  v_enr_id    uuid;
  v_lead_id   uuid;
BEGIN
  -- FOR UPDATE: serializes against enrollment (FOR SHARE) and step edits.
  SELECT workspace_id, status INTO v_workspace, v_status
  FROM public.campaigns WHERE id = _campaign_id FOR UPDATE;
  IF v_workspace IS NULL THEN
    RAISE EXCEPTION 'campaign not found' USING ERRCODE = '42501';
  END IF;
  IF v_caller IS NULL OR NOT public.is_workspace_member(v_workspace, v_caller) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Only a draft outreach can be launched.' USING ERRCODE = '42501';
  END IF;

  IF _plan IS NULL OR jsonb_typeof(_plan) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'plan must be a JSON array';
  END IF;

  -- The plan must cover EXACTLY the not-started enrollments of this campaign.
  SELECT count(*) INTO v_planned FROM jsonb_array_elements(_plan);
  SELECT count(*) INTO v_pending
  FROM public.campaign_enrollment e
  WHERE e.campaign_id = _campaign_id
    AND e.current_step_number = 0
    AND e.status IN ('scheduled', 'active');
  SELECT count(*) INTO v_matched
  FROM jsonb_array_elements(_plan) p
  JOIN public.campaign_enrollment e
    ON e.id = (p->>'enrollment_id')::uuid
   AND e.campaign_id = _campaign_id
   AND e.current_step_number = 0
   AND e.status IN ('scheduled', 'active');
  IF v_planned <> v_pending OR v_matched <> v_pending THEN
    RAISE EXCEPTION 'People were added while you were launching. Please try again.'
      USING ERRCODE = '40001';
  END IF;

  FOR v_elem IN SELECT * FROM jsonb_array_elements(_plan) LOOP
    v_enr_id := (v_elem->>'enrollment_id')::uuid;
    IF v_elem->>'started_at' IS NULL
       OR jsonb_typeof(v_elem->'touches') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_elem->'touches') = 0 THEN
      RAISE EXCEPTION 'each plan entry needs started_at and at least one touch';
    END IF;
    SELECT lead_id INTO v_lead_id FROM public.campaign_enrollment WHERE id = v_enr_id;

    -- One touch per (enrollment, step): rows already there are re-dated in place
    -- (a draft's touches are all still 'scheduled' — nothing has acted on them).
    INSERT INTO public.campaign_touch
      (enrollment_id, campaign_id, lead_id, step_number, channel, status, eligible_at, max_age_at)
    SELECT v_enr_id, _campaign_id, v_lead_id,
           (t->>'step_number')::int,
           t->>'channel',
           'scheduled',
           (t->>'eligible_at')::timestamptz,
           NULLIF(t->>'max_age_at', '')::timestamptz
    FROM jsonb_array_elements(v_elem->'touches') AS t
    ON CONFLICT (enrollment_id, step_number) DO UPDATE
      SET channel     = EXCLUDED.channel,
          status      = 'scheduled',
          eligible_at = EXCLUDED.eligible_at,
          max_age_at  = EXCLUDED.max_age_at;

    UPDATE public.campaign_enrollment
       SET started_at = (v_elem->>'started_at')::timestamptz,
           status     = 'scheduled'
     WHERE id = v_enr_id;
  END LOOP;

  UPDATE public.campaigns SET status = 'active'
   WHERE id = _campaign_id AND status = 'draft';

  RETURN jsonb_build_object('reanchored', v_planned);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.launch_campaign_with_schedule(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.launch_campaign_with_schedule(uuid, jsonb) TO authenticated;
