-- Unit G-B — unify the Outlook dedupe key across both sync paths.
--
-- WHAT CHANGED IN CODE
--   Both Outlook writers now derive their dedupe key from the same helper,
--   `_shared/timelineProjector.ts::outlookEmailDedupeKey`:
--       internetMessageId present  ->  'outlook:<RFC-2822-Message-ID>'
--       otherwise                  ->  'outlook:graph:<graph message id>'
--
--   Previously:
--     * outlook-webhook wrote 'outlook:webhook:<graph id>'
--     * outlook-sync wrote 'outlook:<internetMessageId>' and, when Graph gave
--       no internetMessageId, the UN-NAMESPACED fallback 'outlook:<graph id>'
--
-- WHAT THIS BACKFILL DOES
--   Only the second (un-namespaced graph-id) shape is ambiguous and orphaned by
--   the code change: on the next sync the same message would key as
--   'outlook:graph:<id>' and be stored a SECOND time. This rewrites those rows
--   onto the new key so the existing row is matched instead.
--
--   The 'outlook:webhook:<graph id>' shape is NOT rewritten — it cannot be:
--   the webhook never stored the message's internetMessageId, so the new key is
--   not derivable from the row. Measured on production on 2026-09-14 there are
--   ZERO such rows in either table (the Outlook webhook has never processed a
--   change notification: mail_event_log has 0 rows with provider='outlook'), so
--   nothing is orphaned and no cutover date is needed. The statements below are
--   written to be re-runnable and to be no-ops if that ever stops being true.
--
-- MEASURED IMPACT (production, 2026-09-14, before applying):
--   lead_timeline_items : 1 row   (dedupe_key 'outlook:AAMkADkzNzFl…')
--   interactions        : 0 rows
--   collisions          : 0
--
-- COLLISIONS
--   `interactions` has a GLOBAL unique index on dedupe_key and
--   `lead_timeline_items` a unique (lead_id, dedupe_key). A blind UPDATE that
--   hit an existing target key would abort the whole migration. Each statement
--   therefore skips any row whose target key is already taken; those are, by
--   definition, the duplicate this change exists to prevent, and they are
--   REPORTED (below) rather than silently deleted — deleting timeline history
--   is not something a migration should decide on its own.

BEGIN;

-- Legacy un-namespaced graph-id keys: 'outlook:<something that is not an
-- RFC 2822 Message-ID and not one of our own namespaces>'.
CREATE TEMP TABLE _outlook_key_rewrite ON COMMIT DROP AS
SELECT
  'lead_timeline_items'::text AS src,
  t.id,
  t.lead_id,
  t.dedupe_key AS old_key,
  'outlook:graph:' || substring(t.dedupe_key from 9) AS new_key
FROM lead_timeline_items t
WHERE t.dedupe_key LIKE 'outlook:%'
  AND t.dedupe_key NOT LIKE 'outlook:<%'
  AND t.dedupe_key NOT LIKE 'outlook:graph:%'
  AND t.dedupe_key NOT LIKE 'outlook:interaction:%'
UNION ALL
SELECT
  'interactions'::text,
  i.id,
  i.lead_id,
  i.dedupe_key,
  'outlook:graph:' || substring(i.dedupe_key from 9)
FROM interactions i
WHERE i.dedupe_key LIKE 'outlook:%'
  AND i.dedupe_key NOT LIKE 'outlook:<%'
  AND i.dedupe_key NOT LIKE 'outlook:graph:%'
  AND i.dedupe_key NOT LIKE 'outlook:interaction:%';

DO $$
DECLARE
  v_total int;
  v_tl int;
  v_ix int;
  v_skipped int;
  v_webhook_tl int;
  v_webhook_ix int;
BEGIN
  SELECT count(*) INTO v_total FROM _outlook_key_rewrite;

  -- Timeline rows. Skip any whose target key already exists for the same lead.
  WITH upd AS (
    UPDATE lead_timeline_items t
    SET dedupe_key = r.new_key,
        updated_at = now()
    FROM _outlook_key_rewrite r
    WHERE r.src = 'lead_timeline_items'
      AND t.id = r.id
      AND NOT EXISTS (
        SELECT 1 FROM lead_timeline_items x
        WHERE x.lead_id = t.lead_id AND x.dedupe_key = r.new_key
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_tl FROM upd;

  -- Interaction rows. dedupe_key is globally unique here, so the guard is global.
  WITH upd AS (
    UPDATE interactions i
    SET dedupe_key = r.new_key
    FROM _outlook_key_rewrite r
    WHERE r.src = 'interactions'
      AND i.id = r.id
      AND NOT EXISTS (
        SELECT 1 FROM interactions x WHERE x.dedupe_key = r.new_key
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_ix FROM upd;

  v_skipped := v_total - v_tl - v_ix;

  SELECT count(*) INTO v_webhook_tl
  FROM lead_timeline_items WHERE dedupe_key LIKE 'outlook:webhook:%';
  SELECT count(*) INTO v_webhook_ix
  FROM interactions WHERE dedupe_key LIKE 'outlook:webhook:%';

  RAISE NOTICE 'outlook dedupe backfill: candidates=% rewritten_timeline=% rewritten_interactions=% skipped_collisions=%',
    v_total, v_tl, v_ix, v_skipped;
  RAISE NOTICE 'outlook legacy webhook-keyed rows left in place (not derivable to the new key): timeline=% interactions=%',
    v_webhook_tl, v_webhook_ix;

  IF v_skipped > 0 THEN
    RAISE NOTICE 'outlook dedupe backfill: % row(s) already had a row under the new key and were LEFT AS-IS. Review with the query in the migration header before deleting anything.', v_skipped;
  END IF;
END $$;

COMMIT;

-- Post-apply check (expect 0 rows):
--   SELECT dedupe_key FROM lead_timeline_items
--    WHERE dedupe_key LIKE 'outlook:%'
--      AND dedupe_key NOT LIKE 'outlook:<%'
--      AND dedupe_key NOT LIKE 'outlook:graph:%'
--      AND dedupe_key NOT LIKE 'outlook:interaction:%'
--      AND dedupe_key NOT LIKE 'outlook:webhook:%';
