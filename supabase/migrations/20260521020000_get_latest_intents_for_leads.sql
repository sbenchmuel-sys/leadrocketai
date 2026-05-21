-- ============================================================
-- get_latest_intents_for_leads — server-side per-lead reduction
-- of the latest inbound intent, for the dashboard CommandStrip /
-- Queue UI filter (PR C follow-up; addresses Codex P2 on PR #44).
--
-- Previous JS-side implementation in `fetchIntentHiddenLeadIds`
-- pulled rows from `lead_timeline_items` with `.in().order().limit(5000)`
-- then reduced to "first row per lead_id" in JavaScript. The cap was
-- applied BEFORE the per-lead reduction, so in workspaces with dense
-- inbound histories on a subset of leads, the 5000-row window filled
-- with rows from chatty leads and other lead IDs dropped out of the
-- result entirely. `intentHiddenIds` was silently incomplete and the
-- CommandStrip "Action Required" badge overcounted for the omitted
-- leads.
--
-- This RPC pushes the reduction into Postgres: `DISTINCT ON (lead_id)`
-- ordered by `occurred_at DESC` returns at most one row per requested
-- lead, regardless of how many inbounds each lead has. No client-side
-- de-duplication needed; no row cap; no pagination.
--
-- Authorization: SECURITY DEFINER, but the per-row
-- `is_workspace_member(workspace_id, auth.uid())` clause filters out
-- any lead the caller cannot see. Callers can pass arbitrary lead IDs
-- — unauthorized rows are silently dropped (NOT an error) so the
-- dashboard handles cross-workspace edge cases gracefully without
-- needing to pre-validate lead ownership client-side.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_latest_intents_for_leads(
  p_lead_ids uuid[]
)
RETURNS TABLE (
  lead_id uuid,
  intent  text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT DISTINCT ON (lti.lead_id)
    lti.lead_id,
    lti.intent
  FROM public.lead_timeline_items lti
  WHERE lti.lead_id = ANY(p_lead_ids)
    AND lti.event_type = 'email_inbound'
    AND lti.intent IS NOT NULL
    AND public.is_workspace_member(lti.workspace_id, auth.uid())
  ORDER BY lti.lead_id, lti.occurred_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_latest_intents_for_leads(uuid[])
  TO authenticated;

COMMENT ON FUNCTION public.get_latest_intents_for_leads(uuid[]) IS
  'Return the latest inbound intent per requested lead. Authorized via is_workspace_member; unauthorized lead IDs are silently filtered out. NULL intents (not yet classified by the classify-inbound cron) are also filtered out — callers treat absence as "not hidden". See migration header for the Codex P2 it addresses.';
