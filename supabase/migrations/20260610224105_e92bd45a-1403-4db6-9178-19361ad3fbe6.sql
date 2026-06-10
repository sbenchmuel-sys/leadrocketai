CREATE OR REPLACE FUNCTION public.get_campaign_scorecard(
  _workspace_id uuid,
  _campaign_id  uuid DEFAULT NULL
)
RETURNS TABLE (
  campaign_id   uuid,
  campaign_name text,
  enrolled      bigint,
  sent          bigint,
  replied       bigint,
  meetings      bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _campaign_id IS NULL THEN
    IF NOT public.is_workspace_admin(_workspace_id, auth.uid()) THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.campaigns c
      WHERE c.id = _campaign_id AND c.workspace_id = _workspace_id
    ) THEN
      RAISE EXCEPTION 'campaign not in workspace' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.name,
    (SELECT count(*) FROM public.campaign_enrollment ce
       WHERE ce.campaign_id = c.id)                              AS enrolled,
    (SELECT count(*) FROM public.campaign_touch ct
       WHERE ct.campaign_id = c.id AND ct.status = 'sent')       AS sent,
    (SELECT count(*) FROM public.campaign_enrollment ce
       WHERE ce.campaign_id = c.id AND ce.status = 'replied')    AS replied,
    (SELECT count(DISTINCT lti.lead_id)
       FROM public.campaign_enrollment ce
       JOIN public.lead_timeline_items lti
         ON lti.lead_id = ce.lead_id
        AND lti.event_type = 'meeting'
        AND (ce.started_at IS NULL OR lti.occurred_at >= ce.started_at)
       WHERE ce.campaign_id = c.id)                              AS meetings
  FROM public.campaigns c
  WHERE c.workspace_id = _workspace_id
    AND (_campaign_id IS NULL OR c.id = _campaign_id)
  ORDER BY c.created_at DESC;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_campaign_scorecard(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_campaign_scorecard(uuid, uuid) TO authenticated;