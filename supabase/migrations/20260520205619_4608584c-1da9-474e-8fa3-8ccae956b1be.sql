ALTER TABLE public.lead_timeline_items
  ADD COLUMN IF NOT EXISTS intent_version text;

COMMENT ON COLUMN public.lead_timeline_items.intent_version IS
  'Identifier of the classifier that produced `intent`. NULL for rows classified by Phase 1 heuristic detectors. Phase 2a AI cron writes `intent_router/v1`.';