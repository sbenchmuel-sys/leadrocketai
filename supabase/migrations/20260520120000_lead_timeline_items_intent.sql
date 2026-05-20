-- ============================================================
-- lead_timeline_items.intent — classification column (Phase 1)
--
-- Adds a nullable `intent` column that classifies each timeline row
-- as one of the documented values below. This phase only adds the
-- column + an index; no detector wiring in sync paths yet (Phase 2a).
--
-- The companion `classify-timeline-intent-backfill` edge function
-- populates this column from existing rows using the heuristic
-- detectors that already exist in supabase/functions/_shared/.
--
-- Allowed values (documented, NOT enforced as an enum yet — a CHECK
-- constraint or enum can land in Phase 2a once the AI classifier
-- and the in-line sync writers are also producing values):
--
--   human_reply           — a real human reply that warrants action
--   calendar_accept       — "Accepted: …" calendar acceptance email
--   calendar_invite       — incoming calendar invitation (not yet detected)
--   meeting_confirmation  — body-pattern meeting confirmation
--                           ("see you Tuesday", "looking forward to our call")
--   zoom_recap            — Zoom AI Companion / meeting summary email
--   ooo_reply             — out-of-office auto-reply
--   bounce                — NDR / mail-delivery-failure
--   unsubscribe           — human opt-out request
--   defer_request         — "let's reconnect after Q3" type defers
--   manual_handled        — rep manually marked the row as dealt with
--                           (Phase 2a will introduce the manual-handled path)
--   unknown               — classifier ran and could not decide
--                           (NULL = not yet classified)
--
-- Phase 1 backfill writes:
--   bounce, ooo_reply, unsubscribe, defer_request,
--   meeting_confirmation, calendar_accept, zoom_recap.
-- It does NOT write human_reply, calendar_invite, unknown, or
-- manual_handled; those become reachable in Phase 2a.
-- ============================================================

ALTER TABLE public.lead_timeline_items
  ADD COLUMN IF NOT EXISTS intent text;

COMMENT ON COLUMN public.lead_timeline_items.intent IS
  'Classification of the timeline row. NULL = not yet classified. Allowed values: human_reply, calendar_accept, calendar_invite, meeting_confirmation, zoom_recap, ooo_reply, bounce, unsubscribe, defer_request, manual_handled, unknown. Not enforced as an enum/CHECK yet — that lands in Phase 2a once the in-line sync writers and AI classifier are producing values.';

-- Partial index: only rows that have been classified, ordered by lead.
-- The action-queue UI will filter "show rows whose intent is NOT in
-- {ooo_reply, bounce, calendar_accept, zoom_recap, …}" so a partial
-- index on classified rows is the right shape. Unclassified rows are
-- read via the existing (lead_id, occurred_at DESC) index.
CREATE INDEX IF NOT EXISTS idx_lti_lead_intent
  ON public.lead_timeline_items (lead_id, intent)
  WHERE intent IS NOT NULL;
