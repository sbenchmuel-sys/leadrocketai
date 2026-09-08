BEGIN;

DROP FUNCTION IF EXISTS public.get_latest_intents_for_leads(uuid[]);

CREATE OR REPLACE FUNCTION public.get_latest_intents_for_leads(
  p_lead_ids uuid[]
)
RETURNS TABLE (
  lead_id        uuid,
  intent         text,
  reply_worthy   boolean,
  sender_is_lead boolean
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT DISTINCT ON (lti.lead_id)
    lti.lead_id,
    lti.intent,
    CASE lower(lti.metadata_json -> 'ai_signals' ->> 'reply_worthy')
      WHEN 'true'  THEN true
      WHEN 'false' THEN false
      ELSE NULL
    END AS reply_worthy,
    CASE lower(lti.metadata_json ->> 'sender_is_lead')
      WHEN 'true'  THEN true
      WHEN 'false' THEN false
      ELSE NULL
    END AS sender_is_lead
  FROM public.lead_timeline_items lti
  WHERE lti.lead_id = ANY(p_lead_ids)
    AND lti.event_type IN ('email_inbound', 'whatsapp_inbound', 'sms_inbound')
    AND public.is_workspace_member(lti.workspace_id, auth.uid())
  ORDER BY lti.lead_id, lti.occurred_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_latest_intents_for_leads(uuid[])
  TO authenticated;

COMMENT ON FUNCTION public.get_latest_intents_for_leads(uuid[]) IS
  'Return the genuinely latest inbound row per requested lead (email, WhatsApp or SMS) with its intent and the two hide-relevant signals classify-inbound persists (ai_signals.reply_worthy, sender_is_lead). Authorized via is_workspace_member; unauthorized lead IDs are silently filtered out. Any of the three signal columns may be NULL — NULL always means "not hidden". NOTE: intent is deliberately NOT filtered for NULL any more; doing so inside the DISTINCT ON made a fresh unclassified reply inherit an older bounce''s hide verdict.';

COMMIT;