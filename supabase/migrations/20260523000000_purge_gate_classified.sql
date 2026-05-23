-- Purge-gate the 72-hour body purge on classification completion.
--
-- Background: the public commitment "raw message bodies auto-purge after
-- 72 hours" used to fire unconditionally as soon as `expires_at < now()`.
-- That created a race with the classifier cron (classify-inbound): if a
-- row landed close enough to its 72h mark, its body could be purged
-- BEFORE the classifier had a chance to write `metadata_json.ai_summary`,
-- leaving downstream reply-drafting with subject/headers only.
--
-- This migration changes the gate for INBOUND email rows specifically
-- so their bodies are nulled only when either
-- (a) the row has been classified (`intent IS NOT NULL`), or
-- (b) the row is older than 7 days (hard cap — prevents indefinite
--     retention if the classifier is broken).
--
-- Outbound email rows keep the standard unconditional 72h purge — they
-- have no classifier path and no ai_summary write to wait for. The
-- previous revision of this migration applied the intent-gate to all
-- timeline rows including outbound, which would have extended outbound
-- retention to 7 days (the gate would never satisfy on outbound).
-- Codex P1 on PR #49 caught this.
--
-- The public commitment becomes: "raw bodies purge within 72h of receipt
-- OR (for inbound emails only) shortly after AI classification completes,
-- whichever is later. Absolute maximum retention: 7 days."
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
-- New logic — applies ONLY to inbound rows (classify-inbound only
-- classifies inbounds; outbound rows have no classifier path and
-- therefore no reason to delay their 72h purge):
--
--   WHERE expires_at < now()            -- 72h elapsed since occurred_at
--     AND body IS NOT NULL              -- not already purged
--     AND (
--       NOT inbound                     -- outbound: standard 72h purge
--       OR intent IS NOT NULL           -- inbound classified
--       OR occurred_at < now() - '7d'   -- inbound 7-day hard cap
--     )
--
-- Scoping by inbound-ness is critical (Codex P1 on PR #49): without it,
-- outbound rows would NEVER satisfy the intent branch and would sit on
-- their snippet_text/body_text until the 7-day cap — extending outbound
-- retention well beyond the public 72h commitment.
--
-- Per-table inbound marker:
--   • lead_timeline_items: event_type = 'email_inbound'
--   • interactions:        direction  = 'inbound'  (nullable column —
--                          IS DISTINCT FROM handles legacy null rows)
--
-- For interactions, `intent` does not exist on the table — but every
-- email interaction has a paired lead_timeline_items row written via
-- the canonicalInteraction helper (timeline.source_table='interactions',
-- timeline.source_id=interactions.id; see supabase/functions/_shared/
-- canonicalInteraction.ts). The timeline row's classification status is
-- what gates reply quality. We therefore gate inbound interactions
-- purge on the paired timeline row's intent via a correlated EXISTS —
-- purge an inbound interaction row only when its paired timeline row
-- is classified (or when the interaction is past the 7-day hard cap).
--
-- The 7-day hard cap is on `occurred_at`, not `expires_at`, so the
-- absolute retention ceiling is independent of any expires_at backfill.

-- Return shape: counts per table, so the message-cleanup edge function
-- can keep its existing structured log line. The function is now
-- effectively the single source of truth for purge logic — the edge
-- function just calls it via RPC.
--
-- DROP before CREATE: the previous signature was `RETURNS void` (see
-- 20260223154653 / 20260519000000). PostgreSQL's CREATE OR REPLACE
-- cannot change a function's return type — it would raise "cannot
-- change return type of existing function" and abort the migration
-- inside its enclosing transaction, blocking everything. The only
-- caller is the pg_cron 'expire-messages' job which runs
-- `SELECT public.expire_old_messages()` and ignores the return value,
-- so the DROP is safe: the cron will pick up the new function on its
-- next tick (Codex P1 on PR #49).
DROP FUNCTION IF EXISTS public.expire_old_messages();

CREATE FUNCTION public.expire_old_messages()
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

  -- Email bodies on interactions: outbound rows purge at the standard
  -- 72h. Inbound rows wait for the paired timeline row's intent (or the
  -- 7-day hard cap), so the classifier has a chance to write ai_summary
  -- before the body is gone.
  --
  -- Pair link: timeline.source_table='interactions' AND
  -- timeline.source_id=interactions.id::text (see canonicalInteraction.ts).
  --
  -- Type cast: `lead_timeline_items.source_id` is declared `text` (see
  -- 20260324154224 — "text for flexibility" so non-UUID source ids work).
  -- `interactions.id` is uuid. A bare `lti.source_id = i.id` would raise
  -- `operator does not exist: text = uuid` and abort the whole purge RPC
  -- — Codex P1 on PR #49. Cast the uuid to text to keep the comparison
  -- safe regardless of how source_id was written.
  --
  -- `i.direction IS DISTINCT FROM 'inbound'` covers both outbound rows
  -- (purge at 72h) AND legacy rows with NULL direction (also purge at
  -- 72h — they have no classifier path). Codex P1 on PR #49.
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
        )
        -- Fall-through: an inbound interactions row with NO paired
        -- timeline row (legacy data only — going-forward syncs always
        -- create both) is NOT purged by the classifier branch. The
        -- 7-day hard cap still catches it.
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_interactions_purged FROM purged;

  -- Email snippets on lead_timeline_items: outbound rows purge at the
  -- standard 72h. Inbound rows wait for this row's own intent (or the
  -- 7-day hard cap). `event_type <> 'email_inbound'` covers outbound,
  -- system_note, meeting, and any other non-classified event_type.
  -- Codex P1 on PR #49.
  WITH purged AS (
    UPDATE public.lead_timeline_items
    SET snippet_text = NULL
    WHERE expires_at < NOW()
      AND snippet_text IS NOT NULL
      AND (
        event_type <> 'email_inbound'
        OR intent IS NOT NULL
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
