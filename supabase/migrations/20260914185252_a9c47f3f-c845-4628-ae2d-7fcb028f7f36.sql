BEGIN;

CREATE TEMP TABLE _outlook_key_rewrite ON COMMIT DROP AS
SELECT 'lead_timeline_items'::text AS src, t.id, t.lead_id, t.dedupe_key AS old_key,
       'outlook:' || t.lead_id::text || ':'
         || CASE WHEN substring(t.dedupe_key from 9) LIKE '<%@%>' THEN '' ELSE 'graph:' END
         || substring(t.dedupe_key from 9) AS new_key
FROM lead_timeline_items t
WHERE t.lead_id IS NOT NULL
  AND t.dedupe_key LIKE 'outlook:%'
  AND t.dedupe_key NOT LIKE 'outlook:webhook:%'
  AND t.dedupe_key NOT LIKE 'outlook:interaction:%'
  AND t.dedupe_key NOT LIKE 'outlook:' || t.lead_id::text || ':%'
UNION ALL
SELECT 'interactions', i.id, i.lead_id, i.dedupe_key,
       'outlook:' || i.lead_id::text || ':'
         || CASE WHEN substring(i.dedupe_key from 9) LIKE '<%@%>' THEN '' ELSE 'graph:' END
         || substring(i.dedupe_key from 9)
FROM interactions i
WHERE i.lead_id IS NOT NULL
  AND i.dedupe_key LIKE 'outlook:%'
  AND i.dedupe_key NOT LIKE 'outlook:webhook:%'
  AND i.dedupe_key NOT LIKE 'outlook:interaction:%'
  AND i.dedupe_key NOT LIKE 'outlook:' || i.lead_id::text || ':%';

DO $$
DECLARE
  v_total int; v_tl int; v_ix int; v_skipped int;
  v_orphan_tl int; v_orphan_ix int; v_webhook int;
BEGIN
  SELECT count(*) INTO v_total FROM _outlook_key_rewrite;

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
    RAISE NOTICE 'outlook dedupe backfill: % row(s) already had a row under the new key and were LEFT AS-IS.', v_skipped;
  END IF;
END $$;

ALTER TABLE public.mail_event_log
  DROP CONSTRAINT IF EXISTS mail_event_log_provider_provider_message_id_key;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mail_event_log_provider_account_message_key'
      AND conrelid = 'public.mail_event_log'::regclass
  ) THEN
    ALTER TABLE public.mail_event_log
      ADD CONSTRAINT mail_event_log_provider_account_message_key
      UNIQUE (provider, mail_account_id, provider_message_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pause_leads_on_inbound(
  p_lead_ids uuid[],
  p_reason text,
  p_clear_action boolean DEFAULT true
) RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_leads int;
BEGIN
  IF p_clear_action THEN
    UPDATE public.leads
       SET needs_action = false,
           eligible_at = NULL,
           next_action_key = NULL,
           next_action_label = NULL,
           action_reason_code = NULL
     WHERE id = ANY(p_lead_ids);
  ELSE
    UPDATE public.leads
       SET eligible_at = NULL
     WHERE id = ANY(p_lead_ids);
  END IF;
  GET DIAGNOSTICS v_leads = ROW_COUNT;

  UPDATE public.automation_log
     SET status = 'paused',
         error_message = p_reason,
         completed_at = now()
   WHERE lead_id = ANY(p_lead_ids)
     AND status IN ('pending', 'sent');

  RETURN v_leads;
END;
$$;

COMMIT;