-- ============================================================
-- get_latest_intents_for_leads — rewrite (Unit G-A)
--
-- Three defects fixed, all of which made the Queue lie to the rep:
--
-- 1. STALE HIDE VERDICT. The old body filtered `intent IS NOT NULL`
--    INSIDE the `DISTINCT ON`, so "latest row" meant "latest row that
--    happens to have been classified". A lead whose most recent
--    message is a fresh, not-yet-classified human reply inherited the
--    hide verdict of an OLDER bounce / OOO and stayed hidden. The
--    predicate is gone: the RPC now returns the genuinely latest
--    inbound row and reports its `intent`, which may be NULL. Callers
--    already treat NULL as "not hidden" (both call sites test
--    `row.intent && HIDE_SET.has(row.intent)`), so an unclassified
--    latest message now correctly reads as visible.
--
-- 2. EMAIL-ONLY. `event_type = 'email_inbound'` meant a lead whose
--    only inbound was WhatsApp or SMS got no row at all. Widened to
--    the canonical inbound set — email_inbound, whatsapp_inbound,
--    sms_inbound (the three `*_inbound` event types written by
--    gmail-sync / outlook-sync, whatsapp-events-processor and
--    sms-webhook respectively; see _shared/canonicalInteraction.ts
--    and the ChannelBadge map in src/components/lead/TimelineTab.tsx).
--
-- 3. INTENT WAS THE ONLY SIGNAL. `classify-inbound` now persists the
--    AI signals it was already paying for into
--    `metadata_json.ai_signals`, plus a cheap sender-identity flag at
--    `metadata_json.sender_is_lead`. Two of them are hide-relevant and
--    are surfaced here so the Queue's hide decision stays ONE
--    server-side round-trip:
--      • reply_worthy = false  → the model says no reply is needed
--      • sender_is_lead = false → a colleague / assistant / vendor on
--        the thread wrote this, not the person we're selling to
--    Both are NULLABLE and both are NULL for every row written before
--    this ships. Absence always means "not hidden".
--
-- Return shape changes (two columns added), so this is a DROP +
-- CREATE inside one transaction rather than a bare CREATE OR REPLACE
-- — Postgres cannot change a function's RETURNS TABLE in place. No
-- reader ever observes the function missing. Re-runnable: the DROP is
-- `IF EXISTS` and the CREATE is `OR REPLACE`.
--
-- Existing callers are unaffected: `src/lib/dashboardMetricsService.ts`
-- and `src/lib/queueQueries.ts` both read `lead_id` + `intent`, which
-- keep their names, types and positions.
--
-- Authorization is unchanged: SECURITY DEFINER with a per-row
-- `is_workspace_member(workspace_id, auth.uid())`, so lead IDs the
-- caller cannot see are silently dropped rather than erroring.
--
-- Plan note: the DISTINCT ON is served by the existing
-- `idx_lti_lead_occurred (lead_id, occurred_at DESC)`. The old partial
-- index `idx_lti_lead_intent … WHERE intent IS NOT NULL` is NOT
-- dropped — it still serves other intent lookups.
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.get_latest_intents_for_leads(uuid[]);

CREATE OR REPLACE FUNCTION public.get_latest_intents_for_leads(
  p_lead_ids uuid[]
)
RETURNS TABLE (
  lead_id        uuid,
  intent         text,
  reply_worthy   boolean,
  sender_is_lead boolean
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT DISTINCT ON (lti.lead_id)
    lti.lead_id,
    lti.intent,
    -- Defensive text->boolean: a CASE never raises, whereas a ::boolean
    -- cast on unexpected JSON text would abort the whole query.
    CASE lower(lti.metadata_json -> 'ai_signals' ->> 'reply_worthy')
      WHEN 'true'  THEN true
      WHEN 'false' THEN false
      ELSE NULL
    END AS reply_worthy,
    CASE lower(lti.metadata_json ->> 'sender_is_lead')
      WHEN 'true'  THEN true
      WHEN 'false' THEN false
      ELSE NULL
    END AS sender_is_lead
  FROM public.lead_timeline_items lti
  WHERE lti.lead_id = ANY(p_lead_ids)
    AND lti.event_type IN ('email_inbound', 'whatsapp_inbound', 'sms_inbound')
    AND public.is_workspace_member(lti.workspace_id, auth.uid())
  ORDER BY lti.lead_id, lti.occurred_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_latest_intents_for_leads(uuid[])
  TO authenticated;

COMMENT ON FUNCTION public.get_latest_intents_for_leads(uuid[]) IS
  'Return the genuinely latest inbound row per requested lead (email, WhatsApp or SMS) with its intent and the two hide-relevant signals classify-inbound persists (ai_signals.reply_worthy, sender_is_lead). Authorized via is_workspace_member; unauthorized lead IDs are silently filtered out. Any of the three signal columns may be NULL — NULL always means "not hidden". NOTE: intent is deliberately NOT filtered for NULL any more; doing so inside the DISTINCT ON made a fresh unclassified reply inherit an older bounce''s hide verdict.';

COMMIT;
