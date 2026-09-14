-- Unit G-B — one LEAD-SCOPED Outlook dedupe key, and the backfill onto it.
--
-- WHAT CHANGED IN CODE
--   Both Outlook writers (outlook-sync, outlook-webhook) now build their key
--   with `_shared/dedupeKeys.ts::outlookEmailDedupeKey`, which is lead-scoped:
--       internetMessageId → 'outlook:<leadId>:<RFC-2822-Message-ID>'
--       else graph id     → 'outlook:<leadId>:graph:<graph message id>'
--       else              → 'outlook:<leadId>:interaction:<interaction id>'
--
--   Previously:
--     * outlook-webhook wrote 'outlook:webhook:<graph id>'
--     * outlook-sync wrote 'outlook:<internetMessageId>', and when Graph gave
--       no internetMessageId the un-namespaced 'outlook:<graph id>'
--
-- WHY LEAD-SCOPED, NOT JUST UNIFIED
--   Unifying the two paths on the Message-ID fixed "the same email stored
--   twice" and opened something worse. `internetMessageId` is the RFC 2822
--   Message-ID and it is GLOBAL: one sender emailing two DrivePilot customers
--   produces two copies carrying the SAME Message-ID. `interactions.dedupe_key`
--   is globally unique, so the second workspace's insert raised 23505,
--   createCanonicalInteraction resolved it to the FIRST workspace's interaction
--   row, and projected that foreign interaction id into the second lead's
--   timeline. A cross-tenant write.
--
--   The scope is the LEAD rather than the workspace because workspace scoping
--   leaves a real same-workspace case: a rep emailing two leads at one company
--   sends ONE message that is a legitimate direct conversation with both, so
--   both leads' syncs would build the same key and the second would again
--   resolve to the first's row. Lead scoping closes both, and it matches what
--   `lead_timeline_items` already enforces — unique (lead_id, dedupe_key), i.e.
--   lead-scoped all along. Only `interactions`' index was broader than the
--   identity it indexed.
--
-- WHAT THIS BACKFILL DOES
--   Rewrites every legacy Outlook key onto the lead-scoped shape, deriving the
--   scope from the row's own `lead_id`. That derivation is COMPLETE — unlike
--   the webhook shape, which could never be rewritten because the webhook never
--   stored the message's internetMessageId. (Measured: there are no rows under
--   the webhook shape, so nothing is left behind by that gap.)
--
-- MEASURED IMPACT (production, 2026-09-14, before applying):
--   lead_timeline_items : 580 'outlook:<Message-ID>'  +  1 'outlook:<graph id>'
--   interactions        : 372 'outlook:<Message-ID>'
--   'outlook:webhook:%' : 0 rows in both tables
--   rows with a NULL lead_id among the above: 0
--
-- COLLISIONS
--   None are possible by construction: the rewrite prefixes each key with the
--   row's own lead_id, so two rows can only collide afterwards if they already
--   shared BOTH lead_id and key — which the existing unique constraints already
--   forbid. The guards below are kept anyway, because a migration that can
--   abort halfway is worse than one that reports what it skipped.
--
-- DELIBERATELY LEFT ALONE
--   'outlook:interaction:<uuid>' (14 timeline rows): already unique per
--   interaction UUID, so it carries no cross-tenant risk, and rewriting it would
--   be churn for no behaviour change. Both shapes read correctly; only the
--   Message-ID-derived ones were ambiguous.

BEGIN;

-- Legacy Outlook keys that derive from a message id and are therefore
-- tenant-ambiguous: 'outlook:<Message-ID>' and 'outlook:<graph id>'.
-- Excludes the already-scoped new shape, the UUID fallback, and the webhook
-- shape (which is not derivable and, measured, does not occur).
CREATE TEMP TABLE _outlook_key_rewrite ON COMMIT DROP AS
SELECT 'lead_timeline_items'::text AS src, t.id, t.lead_id, t.dedupe_key AS old_key,
       'outlook:' || t.lead_id::text || ':' || substring(t.dedupe_key from 9) AS new_key
FROM lead_timeline_items t
WHERE t.lead_id IS NOT NULL
  AND t.dedupe_key LIKE 'outlook:%'
  AND t.dedupe_key NOT LIKE 'outlook:webhook:%'
  AND t.dedupe_key NOT LIKE 'outlook:interaction:%'
  AND t.dedupe_key NOT LIKE 'outlook:' || t.lead_id::text || ':%'
UNION ALL
SELECT 'interactions', i.id, i.lead_id, i.dedupe_key,
       'outlook:' || i.lead_id::text || ':' || substring(i.dedupe_key from 9)
FROM interactions i
WHERE i.lead_id IS NOT NULL
  AND i.dedupe_key LIKE 'outlook:%'
  AND i.dedupe_key NOT LIKE 'outlook:webhook:%'
  AND i.dedupe_key NOT LIKE 'outlook:interaction:%'
  AND i.dedupe_key NOT LIKE 'outlook:' || i.lead_id::text || ':%';

DO $$
DECLARE
  v_total int;
  v_tl int;
  v_ix int;
  v_skipped int;
  v_orphan_tl int;
  v_orphan_ix int;
  v_webhook int;
BEGIN
  SELECT count(*) INTO v_total FROM _outlook_key_rewrite;

  -- Timeline rows. Unique is (lead_id, dedupe_key), so the guard is per lead.
  WITH upd AS (
    UPDATE lead_timeline_items t
    SET dedupe_key = r.new_key, updated_at = now()
    FROM _outlook_key_rewrite r
    WHERE r.src = 'lead_timeline_items' AND t.id = r.id
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
    WHERE r.src = 'interactions' AND i.id = r.id
      AND NOT EXISTS (SELECT 1 FROM interactions x WHERE x.dedupe_key = r.new_key)
    RETURNING 1
  )
  SELECT count(*) INTO v_ix FROM upd;

  v_skipped := v_total - v_tl - v_ix;

  -- Anything still carrying a tenant-ambiguous Outlook key afterwards.
  SELECT count(*) INTO v_orphan_tl FROM lead_timeline_items
   WHERE dedupe_key LIKE 'outlook:%'
     AND dedupe_key NOT LIKE 'outlook:interaction:%'
     AND (lead_id IS NULL OR dedupe_key NOT LIKE 'outlook:' || lead_id::text || ':%');
  SELECT count(*) INTO v_orphan_ix FROM interactions
   WHERE dedupe_key LIKE 'outlook:%'
     AND dedupe_key NOT LIKE 'outlook:interaction:%'
     AND (lead_id IS NULL OR dedupe_key NOT LIKE 'outlook:' || lead_id::text || ':%');
  SELECT count(*) INTO v_webhook FROM lead_timeline_items WHERE dedupe_key LIKE 'outlook:webhook:%';

  RAISE NOTICE 'outlook dedupe backfill: candidates=% rewritten_timeline=% rewritten_interactions=% skipped_collisions=%',
    v_total, v_tl, v_ix, v_skipped;
  RAISE NOTICE 'outlook dedupe backfill: unscoped remaining timeline=% interactions=% (webhook-shaped=%)',
    v_orphan_tl, v_orphan_ix, v_webhook;

  IF v_skipped > 0 THEN
    RAISE NOTICE 'outlook dedupe backfill: % row(s) already had a row under the new key and were LEFT AS-IS. Review before deleting anything.', v_skipped;
  END IF;
END $$;

COMMIT;

-- Post-apply check. Expect 0 rows in both: every Outlook key either carries its
-- own lead's scope or is the UUID fallback.
--   SELECT dedupe_key FROM lead_timeline_items
--    WHERE dedupe_key LIKE 'outlook:%'
--      AND dedupe_key NOT LIKE 'outlook:interaction:%'
--      AND dedupe_key NOT LIKE 'outlook:' || lead_id::text || ':%';
--   SELECT dedupe_key FROM interactions
--    WHERE dedupe_key LIKE 'outlook:%'
--      AND dedupe_key NOT LIKE 'outlook:interaction:%'
--      AND dedupe_key NOT LIKE 'outlook:' || lead_id::text || ':%';
