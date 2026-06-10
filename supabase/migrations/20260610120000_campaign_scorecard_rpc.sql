-- ═══════════════════════════════════════════════════════════════════
-- Unit 5 (PR 5.1) — campaign scorecard rollup RPC.
--
-- Read-only. Additive. Creates ONE function and grants EXECUTE. Touches
-- no table, no row, no behavior. Counting only — over the rows that the
-- Outreach engine (campaign_enrollment / campaign_touch) already writes,
-- plus the existing meeting signal on lead_timeline_items.
--
-- Why a SECURITY DEFINER RPC instead of plain client aggregation:
-- campaign_enrollment / campaign_touch are OWNER-or-admin scoped (a rep
-- only sees their OWN leads' rows). A non-admin aggregating those tables
-- under RLS would silently UNDER-count a shared campaign. The scorecard
-- must report the FULL campaign totals, so it runs as DEFINER and gates
-- authorization EXPLICITLY (RLS is bypassed inside a DEFINER function):
--   • workspace-wide rollup (_campaign_id IS NULL) → workspace ADMINS only
--     (the founder-only Insights page).
--   • single campaign (_campaign_id given)         → any workspace MEMBER,
--     and the campaign must belong to _workspace_id (the compact card on
--     CampaignDetail).
-- Anything else raises 42501 (insufficient_privilege) — fail closed.
--
-- Metric definitions (counts, never per-lead data — low sensitivity):
--   enrolled → every enrollment row for the campaign (total put on cadence).
--   sent     → campaign_touch rows with status='sent' (all channels: email
--              auto/review sends AND rep "Sent it" on manual touches).
--   replied  → enrollments whose status='replied' (the reply bridge sets
--              this and ends the cadence).
--   meetings → distinct enrolled leads with a lead_timeline_items meeting
--              event at/after their enrollment's started_at anchor.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_campaign_scorecard(
  _workspace_id uuid,
  _campaign_id  uuid DEFAULT NULL
)
RETURNS TABLE (
  campaign_id   uuid,
  campaign_name text,
  enrolled      bigint,
  sent          bigint,
  replied       bigint,
  meetings      bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- ── Authorization (DEFINER bypasses RLS → gate here, fail closed) ──
  IF _campaign_id IS NULL THEN
    -- Workspace-wide rollup = the founder-only Insights page → admins only.
    IF NOT public.is_workspace_admin(_workspace_id, auth.uid()) THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
    END IF;
  ELSE
    -- Single-campaign card → any member of the workspace, and the campaign
    -- must actually belong to that workspace (no cross-workspace probing).
    IF NOT public.is_workspace_member(_workspace_id, auth.uid()) THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.campaigns c
      WHERE c.id = _campaign_id AND c.workspace_id = _workspace_id
    ) THEN
      RAISE EXCEPTION 'campaign not in workspace' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Per-metric scalar subqueries (NOT a multi-join) so independent 1:N
  -- relationships can't fan out and inflate one another's counts.
  RETURN QUERY
  SELECT
    c.id,
    c.name,
    (SELECT count(*) FROM public.campaign_enrollment ce
       WHERE ce.campaign_id = c.id)                              AS enrolled,
    (SELECT count(*) FROM public.campaign_touch ct
       WHERE ct.campaign_id = c.id AND ct.status = 'sent')       AS sent,
    (SELECT count(*) FROM public.campaign_enrollment ce
       WHERE ce.campaign_id = c.id AND ce.status = 'replied')    AS replied,
    (SELECT count(DISTINCT lti.lead_id)
       FROM public.campaign_enrollment ce
       JOIN public.lead_timeline_items lti
         ON lti.lead_id = ce.lead_id
        AND lti.event_type = 'meeting'
        AND (ce.started_at IS NULL OR lti.occurred_at >= ce.started_at)
       WHERE ce.campaign_id = c.id)                              AS meetings
  FROM public.campaigns c
  WHERE c.workspace_id = _workspace_id
    AND (_campaign_id IS NULL OR c.id = _campaign_id)
  ORDER BY c.created_at DESC;
END;
$$;

-- Least privilege: revoke the default PUBLIC execute (so anon can't even call
-- it), then grant only to signed-in users. The in-function gate already
-- fail-closes for a null auth.uid(), but don't rely on that alone.
REVOKE EXECUTE ON FUNCTION public.get_campaign_scorecard(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_campaign_scorecard(uuid, uuid) TO authenticated;
