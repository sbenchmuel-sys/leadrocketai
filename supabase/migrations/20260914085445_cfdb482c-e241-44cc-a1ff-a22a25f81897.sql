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
  SELECT workspace_id INTO v_workspace
  FROM public.campaigns WHERE id = _campaign_id FOR SHARE;
  IF v_workspace IS NULL THEN
    RAISE EXCEPTION 'campaign not found' USING ERRCODE = '42501';
  END IF;
  IF v_caller IS NULL OR NOT public.is_workspace_member(v_workspace, v_caller) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  v_is_admin := public.is_workspace_admin(v_workspace, v_caller);

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

  IF _enrollments IS NULL OR jsonb_typeof(_enrollments) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'enrollments must be a JSON array';
  END IF;
  SELECT count(*) INTO v_count FROM jsonb_array_elements(_enrollments);
  IF v_count = 0 THEN
    RETURN jsonb_build_object('enrolled', '[]'::jsonb, 'skipped', '[]'::jsonb);
  END IF;

  PERFORM 1
  FROM public.leads
  WHERE id IN (SELECT (e->>'lead_id')::uuid FROM jsonb_array_elements(_enrollments) e)
    AND workspace_id = v_workspace
  ORDER BY id
  FOR UPDATE;

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