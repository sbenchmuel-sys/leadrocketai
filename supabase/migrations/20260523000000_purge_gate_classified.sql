-- Purge-gate the 72-hour body purge on classification completion.
--
-- Background: the public commitment "raw message bodies auto-purge after
-- 72 hours" used to fire unconditionally as soon as `expires_at < now()`.
-- That created a race with the classifier cron (classify-inbound): if a
-- row landed close enough to its 72h mark, its body could be purged
-- BEFORE the classifier had a chance to write `metadata_json.ai_summary`,
-- leaving downstream reply-drafting with subject/headers only.
--
-- This migration changes the gate so bodies are nulled only when either
-- (a) the row has been classified (`intent IS NOT NULL`), or
-- (b) the row is older than 7 days (hard cap — prevents indefinite
--     retention if the classifier is broken).
--
-- The public commitment becomes: "raw bodies purge within 72h of receipt
-- OR shortly after AI classification completes, whichever is later.
-- Absolute maximum retention: 7 days."
--
-- This migration updates BOTH tables that hold email bodies:
--   • lead_timeline_items.snippet_text
--   • interactions.body_text
-- …with the same gate logic. (messages.body_ciphertext — WhatsApp/SMS —
-- does NOT go through classify-inbound and keeps the old unconditional
-- gate.)
--
-- The message-cleanup edge function (hourly cron caller) is updated in
-- the same PR to apply the same gate at the application layer.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Update expire_old_messages() — the DB-level fallback.
-- ---------------------------------------------------------------------------
--
-- New logic per body table:
--   WHERE expires_at < now()        -- 72h elapsed since occurred_at
--     AND body IS NOT NULL          -- not already purged
--     AND (
--       intent IS NOT NULL          -- classifier has run (lead_timeline_items)
--       OR occurred_at < now() - interval '7 days'  -- hard cap
--     )
--
-- For interactions, `intent` does not exist on the table — but every
-- email interaction has a paired lead_timeline_items row written via
-- the canonicalInteraction helper (timeline.source_table='interactions',
-- timeline.source_id=interactions.id; see supabase/functions/_shared/
-- canonicalInteraction.ts). The timeline row's classification status is
-- what gates reply quality. We therefore gate interactions purge on the
-- paired timeline row's intent via a correlated EXISTS — purge an
-- interactions row only when its paired timeline row is classified (or
-- when the interaction is past the 7-day hard cap).
--
-- The 7-day hard cap is on `occurred_at`, not `expires_at`, so the
-- absolute retention ceiling is independent of any expires_at backfill.

-- Return shape: counts per table, so the message-cleanup edge function
-- can keep its existing structured log line. The function is now
-- effectively the single source of truth for purge logic — the edge
-- function just calls it via RPC.
CREATE OR REPLACE FUNCTION public.expire_old_messages()
RETURNS TABLE (
  messages_purged integer,
  interactions_purged integer,
  lead_timeline_items_purged integer
) AS $$
DECLARE
  v_messages_purged integer := 0;
  v_interactions_purged integer := 0;
  v_timeline_purged integer := 0;
BEGIN
  -- WhatsApp / SMS: not classified by classify-inbound, keep original gate.
  WITH purged AS (
    UPDATE public.messages
    SET body_ciphertext = NULL
    WHERE expires_at < NOW()
      AND body_ciphertext IS NOT NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_messages_purged FROM purged;

  -- Email bodies on interactions: gate on the paired timeline row's
  -- intent (when one exists), OR on the 7-day hard cap.
  -- Pair link: timeline.source_table='interactions' AND
  -- timeline.source_id=interactions.id (see canonicalInteraction.ts).
  WITH purged AS (
    UPDATE public.interactions i
    SET body_text = NULL
    WHERE i.expires_at < NOW()
      AND i.body_text IS NOT NULL
      AND (
        i.occurred_at < NOW() - INTERVAL '7 days'
        OR EXISTS (
          SELECT 1
          FROM public.lead_timeline_items lti
          WHERE lti.source_table = 'interactions'
            AND lti.source_id = i.id
            AND lti.intent IS NOT NULL
        )
        -- Fall-through: an interactions row with NO paired timeline row
        -- (legacy data only — going-forward syncs always create both) is
        -- NOT purged by the classifier branch. The 7-day hard cap still
        -- catches it.
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_interactions_purged FROM purged;

  -- Email snippets on lead_timeline_items: gate on this row's own intent
  -- OR the 7-day hard cap.
  WITH purged AS (
    UPDATE public.lead_timeline_items
    SET snippet_text = NULL
    WHERE expires_at < NOW()
      AND snippet_text IS NOT NULL
      AND (
        intent IS NOT NULL
        OR occurred_at < NOW() - INTERVAL '7 days'
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_timeline_purged FROM purged;

  messages_purged := v_messages_purged;
  interactions_purged := v_interactions_purged;
  lead_timeline_items_purged := v_timeline_purged;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public';

COMMIT;
