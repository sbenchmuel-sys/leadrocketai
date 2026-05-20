ALTER TABLE public.lead_timeline_items
  ADD COLUMN IF NOT EXISTS intent text;

COMMENT ON COLUMN public.lead_timeline_items.intent IS
  'Classification of the timeline row. NULL = not yet classified. Allowed values: human_reply, calendar_accept, calendar_invite, meeting_confirmation, zoom_recap, ooo_reply, bounce, unsubscribe, defer_request, manual_handled, unknown. Not enforced as an enum/CHECK yet — that lands in Phase 2a once the in-line sync writers and AI classifier are producing values.';

CREATE INDEX IF NOT EXISTS idx_lti_lead_intent
  ON public.lead_timeline_items (lead_id, intent)
  WHERE intent IS NOT NULL;