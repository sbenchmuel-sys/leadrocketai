-- Project timeline item for the fixed call session
INSERT INTO public.lead_timeline_items (
  workspace_id, lead_id, channel, provider, direction, event_type,
  occurred_at, source_table, source_id, snippet_text, metadata_json, dedupe_key
)
SELECT
  cs.workspace_id,
  cs.lead_id,
  'voice',
  'twilio',
  cs.direction,
  'call_completed',
  cs.started_at,
  'call_sessions',
  cs.id::text,
  'Phone call (outbound) — 2 min',
  jsonb_build_object('call_sid', cs.call_sid, 'duration_sec', cs.duration_sec, 'status', 'completed'),
  'call:' || cs.id::text
FROM public.call_sessions cs
WHERE cs.id = 'cde9279c-f0fd-4540-bda5-ec9eb04985db'
  AND cs.lead_id IS NOT NULL
ON CONFLICT (lead_id, dedupe_key) DO NOTHING;