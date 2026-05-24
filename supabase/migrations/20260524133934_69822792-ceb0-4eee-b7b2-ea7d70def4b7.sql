
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
  -- WhatsApp/SMS: unconditional 72h purge (no classifier path, short retention).
  WITH purged AS (
    UPDATE public.messages
    SET body_ciphertext = NULL
    WHERE expires_at < NOW()
      AND body_ciphertext IS NOT NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_messages_purged FROM purged;

  -- interactions.body_text (email): 30-day hard cap for BOTH directions.
  -- Inbound additionally allows early purge once classifier wrote intent+ai_summary
  -- (privacy-preferred). Outbound keeps full 30 days so reply generation can see
  -- what we previously promised the customer.
  WITH purged AS (
    UPDATE public.interactions i
    SET body_text = NULL
    WHERE i.body_text IS NOT NULL
      AND i.occurred_at < NOW() - INTERVAL '30 days'
    RETURNING 1
  )
  SELECT count(*) INTO v_interactions_purged FROM purged;

  -- lead_timeline_items.snippet_text:
  --   * email rows (inbound + outbound): 30-day hard cap.
  --   * non-email rows (system_note, meeting, etc.): 72h unconditional via expires_at.
  WITH purged AS (
    UPDATE public.lead_timeline_items
    SET snippet_text = NULL
    WHERE snippet_text IS NOT NULL
      AND (
        (event_type IN ('email_inbound', 'email_outbound')
          AND occurred_at < NOW() - INTERVAL '30 days')
        OR
        (event_type NOT IN ('email_inbound', 'email_outbound')
          AND expires_at < NOW())
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
