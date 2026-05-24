CREATE OR REPLACE FUNCTION public.expire_old_messages()
 RETURNS TABLE(messages_purged integer, interactions_purged integer, lead_timeline_items_purged integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_messages_purged integer := 0;
  v_interactions_purged integer := 0;
  v_timeline_purged integer := 0;
BEGIN
  -- WhatsApp/SMS: unconditional 72h purge (no classifier path).
  WITH purged AS (
    UPDATE public.messages
    SET body_ciphertext = NULL
    WHERE expires_at < NOW()
      AND body_ciphertext IS NOT NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_messages_purged FROM purged;

  -- interactions.body_text:
  --   * outbound rows: 72h unconditional.
  --   * inbound rows: keep until the paired timeline row has BOTH intent
  --     AND ai_summary, OR until 7 days have elapsed (hard cap).
  WITH purged AS (
    UPDATE public.interactions i
    SET body_text = NULL
    WHERE i.expires_at < NOW()
      AND i.body_text IS NOT NULL
      AND (
        i.direction IS DISTINCT FROM 'inbound'
        OR i.occurred_at < NOW() - INTERVAL '7 days'
        OR EXISTS (
          SELECT 1
          FROM public.lead_timeline_items lti
          WHERE lti.source_table = 'interactions'
            AND lti.source_id = i.id::text
            AND lti.intent IS NOT NULL
            AND (lti.metadata_json->>'ai_summary') IS NOT NULL
        )
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_interactions_purged FROM purged;

  -- lead_timeline_items.snippet_text:
  --   * non-inbound event types: 72h unconditional.
  --   * email_inbound rows: keep until BOTH intent AND ai_summary land,
  --     OR until 7 days have elapsed (hard cap).
  WITH purged AS (
    UPDATE public.lead_timeline_items
    SET snippet_text = NULL
    WHERE expires_at < NOW()
      AND snippet_text IS NOT NULL
      AND (
        event_type <> 'email_inbound'
        OR occurred_at < NOW() - INTERVAL '7 days'
        OR (intent IS NOT NULL AND (metadata_json->>'ai_summary') IS NOT NULL)
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_timeline_purged FROM purged;

  messages_purged := v_messages_purged;
  interactions_purged := v_interactions_purged;
  lead_timeline_items_purged := v_timeline_purged;
  RETURN NEXT;
END;
$function$;