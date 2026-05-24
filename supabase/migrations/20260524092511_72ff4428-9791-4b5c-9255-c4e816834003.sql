
-- Backfill lead_timeline_items from interactions where the mirror row is missing.
-- Root cause: queue previews read from lead_timeline_items only; 557 inbound
-- interactions (and a smaller number of outbound) never got projected.
INSERT INTO public.lead_timeline_items (
  workspace_id, lead_id, channel, provider, direction, event_type,
  occurred_at, source_table, source_id, snippet_text, subject,
  status_json, metadata_json, dedupe_key, expires_at
)
SELECT
  l.workspace_id,
  i.lead_id,
  'email'::text AS channel,
  COALESCE(i.source, 'gmail') AS provider,
  i.direction,
  CASE WHEN i.direction = 'inbound' THEN 'email_inbound' ELSE 'email_outbound' END AS event_type,
  i.occurred_at,
  'interactions'::text AS source_table,
  i.id::text AS source_id,
  LEFT(i.body_text, 500) AS snippet_text,
  i.subject,
  '{}'::jsonb AS status_json,
  jsonb_strip_nulls(jsonb_build_object(
    'from_email', i.from_email,
    'to_emails',  i.to_emails,
    'cc_emails',  i.cc_emails,
    'ai_summary', i.ai_summary,
    'gmail_message_id', i.gmail_message_id,
    'gmail_thread_id',  i.gmail_thread_id,
    'backfilled_from_interactions', true
  )) AS metadata_json,
  CASE
    WHEN i.gmail_message_id IS NOT NULL
      THEN COALESCE(i.source, 'gmail') || ':' || i.gmail_message_id
    ELSE COALESCE(i.source, 'gmail') || ':interaction:' || i.id::text
  END AS dedupe_key,
  COALESCE(i.expires_at, i.occurred_at + interval '72 hours') AS expires_at
FROM public.interactions i
JOIN public.leads l ON l.id = i.lead_id
WHERE i.direction IN ('inbound','outbound')
  AND NOT EXISTS (
    SELECT 1 FROM public.lead_timeline_items lti
    WHERE lti.source_table = 'interactions'
      AND lti.source_id = i.id::text
  )
ON CONFLICT (lead_id, dedupe_key) DO NOTHING;
