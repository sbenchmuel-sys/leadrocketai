-- ============================================================
-- lead_timeline_items.intent_version — classifier version tag (Phase 2a)
--
-- Companion column to `intent` (added in
-- 20260520120000_lead_timeline_items_intent.sql). Records which
-- classifier produced the row's intent value so future versions can
-- safely revise semantics without losing the provenance of
-- already-classified rows.
--
-- Conventions:
--   • Phase 1 deterministic detectors (bounce, ooo_reply, …) leave
--     intent_version NULL — backfill happened via
--     `classify-timeline-intent-backfill` from `_shared/` heuristics.
--   • Phase 2a AI cron writes `intent_router/v1` (matches the
--     `ai_task` task name + prompt revision).
--   • If `intent` is NULL, `intent_version` should also be NULL.
--
-- No index — the column is only read alongside `intent`, which is
-- already partial-indexed by 20260520120000_lead_timeline_items_intent.sql.
-- ============================================================

ALTER TABLE public.lead_timeline_items
  ADD COLUMN IF NOT EXISTS intent_version text;

COMMENT ON COLUMN public.lead_timeline_items.intent_version IS
  'Identifier of the classifier that produced `intent`. NULL for rows classified by Phase 1 heuristic detectors. Phase 2a AI cron writes `intent_router/v1`.';
