CREATE OR REPLACE FUNCTION public.get_campaign_touch_stats(_workspace_id uuid)
RETURNS TABLE(
  campaign_id   uuid,
  campaign_name text,
  campaign_status text,
  enrolled      bigint,
  sent          bigint,
  handled       bigint,
  skipped       bigint,
  pending       bigint,
  failed        bigint,
  replied       bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.name,
    c.status,
    (SELECT count(*) FROM public.campaign_enrollment ce
       WHERE ce.campaign_id = c.id)                                       AS enrolled,
    (SELECT count(*) FROM public.campaign_touch ct
       WHERE ct.campaign_id = c.id AND ct.status = 'sent'
         AND ct.channel = 'email')                                        AS sent,
    (SELECT count(*) FROM public.campaign_touch ct
       WHERE ct.campaign_id = c.id AND ct.status = 'sent'
         AND ct.channel <> 'email')                                       AS handled,
    (SELECT count(*) FROM public.campaign_touch ct
       WHERE ct.campaign_id = c.id
         AND ct.status IN ('skipped', 'auto_skipped'))                    AS skipped,
    (SELECT count(*) FROM public.campaign_touch ct
       WHERE ct.campaign_id = c.id
         AND ct.status IN ('scheduled', 'queued'))                        AS pending,
    (SELECT count(*) FROM public.campaign_touch ct
       WHERE ct.campaign_id = c.id AND ct.status = 'failed')              AS failed,
    (SELECT count(*) FROM public.campaign_enrollment ce
       WHERE ce.campaign_id = c.id AND ce.status = 'replied')             AS replied
  FROM public.campaigns c
  WHERE c.workspace_id = _workspace_id
  ORDER BY c.created_at DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_campaign_touch_stats(uuid) TO authenticated;