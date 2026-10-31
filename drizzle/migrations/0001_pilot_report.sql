-- ═══════════════════════════════════════════════════════════════════
-- pilot_report(workspace, from, to, owner_ids) — the ONE source of numbers for a
-- client pilot report (the Monday email AND the Pilot page read this, so they
-- always agree). Read-only. Admins of the workspace (or the service role, which
-- has no auth.uid()) may call it; anon is revoked below.
--
-- _owner_ids scopes everything to the pilot's rep(s): only leads they OWN, and only
-- calls they PLACED. A client's own pipeline living in the same workspace (e.g. the
-- CRO working his own deals) is therefore never counted. NULL = whole workspace.
--
-- Definitions (kept in step with the "Cliff's reporting" table in the pilot plan):
--   emails_sent        email_outbound timeline rows
--   replies            distinct leads with a non-OOO email_inbound
--   positive_replies   distinct leads whose inbound intent is a buying signal
--   bounces            cold enrollments stamped bounced_at
--   linkedin_done      LinkedIn cadence steps the rep marked done
--   linkedin_accepted  leads whose "They accepted my invite" was set
--   calls_dialled      outbound call sessions
--   conversations      outbound calls lasting >= 60s
--   calls_answered     max(conversations, rep "Got them" taps)
--                      ponytail: calls and taps aren't linked row-to-row, so this is
--                      a floor, not an exact join. Upgrade path: stamp the
--                      call_session id on the touch when the outcome is recorded.
--   meetings_booked    distinct leads with a meeting / calendar accept / "let's meet"
--   waiting_on_rep     queued touches in active campaigns overdue > 2 days at _to
--   highlights         up to 3 call recaps + 3 reply summaries (AI paraphrases only —
--                      never raw bodies, honouring the 72h body purge)
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.pilot_report(
  _workspace_id uuid, _from timestamptz, _to timestamptz, _owner_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_workspace_admin(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only workspace admins can view the pilot report' USING ERRCODE = '42501';
  END IF;

  WITH ml AS (  -- the leads this report is about
    SELECT id, name, company, stage, linkedin_connected_at FROM leads
     WHERE workspace_id = _workspace_id
       AND (_owner_ids IS NULL OR owner_user_id = ANY(_owner_ids))
  ),
  calls AS (    -- outbound calls in the window, placed by the rep(s)
    SELECT cs.id, cs.lead_id, cs.duration_sec FROM call_sessions cs
     WHERE cs.workspace_id = _workspace_id AND cs.direction = 'outbound'
       AND cs.created_at >= _from AND cs.created_at < _to
       AND (_owner_ids IS NULL OR cs.agent_user_id = ANY(_owner_ids))
  ),
  touches AS (  -- cadence touches on those leads
    SELECT t.* FROM campaign_touch t JOIN campaigns c ON c.id = t.campaign_id
     WHERE c.workspace_id = _workspace_id AND t.lead_id IN (SELECT id FROM ml)
  ),
  items AS (    -- timeline rows on those leads in the window
    SELECT i.* FROM lead_timeline_items i
     WHERE i.workspace_id = _workspace_id AND i.lead_id IN (SELECT id FROM ml)
       AND i.occurred_at >= _from AND i.occurred_at < _to
  )
  SELECT jsonb_build_object(
    'from', _from, 'to', _to,
    'emails_sent', (SELECT count(*) FROM items WHERE event_type = 'email_outbound'),
    'replies', (SELECT count(DISTINCT lead_id) FROM items
                 WHERE event_type = 'email_inbound' AND intent IS DISTINCT FROM 'ooo_reply'),
    'positive_replies', (SELECT count(DISTINCT lead_id) FROM items
                          WHERE event_type = 'email_inbound'
                            AND intent IN ('book_meeting', 'calendar_accept', 'meeting_confirmation', 'pricing', 'partnership')),
    'bounces', (SELECT count(*) FROM campaign_enrollment e JOIN campaigns c ON c.id = e.campaign_id
                 WHERE c.workspace_id = _workspace_id AND e.lead_id IN (SELECT id FROM ml)
                   AND e.bounced_at >= _from AND e.bounced_at < _to),
    'linkedin_done', (SELECT count(*) FROM touches
                       WHERE channel = 'linkedin' AND status = 'sent' AND sent_at >= _from AND sent_at < _to),
    'linkedin_accepted', (SELECT count(*) FROM ml
                           WHERE linkedin_connected_at >= _from AND linkedin_connected_at < _to),
    'calls_dialled', (SELECT count(*) FROM calls),
    'conversations', (SELECT count(*) FROM calls WHERE duration_sec >= 60),
    'calls_answered', greatest(
        (SELECT count(*) FROM calls WHERE duration_sec >= 60),
        (SELECT count(*) FROM touches WHERE channel = 'voice' AND call_outcome = 'got_them'
                                        AND sent_at >= _from AND sent_at < _to)),
    'meetings_booked', (SELECT count(DISTINCT lead_id) FROM items
                         WHERE event_type = 'meeting'
                            OR (event_type = 'email_inbound' AND intent IN ('book_meeting', 'calendar_accept', 'meeting_confirmation'))),
    'waiting_on_rep', (SELECT count(*) FROM touches t JOIN campaigns c ON c.id = t.campaign_id
                        WHERE c.status = 'active' AND t.status = 'queued' AND t.eligible_at < _to - interval '2 days'),
    'leads_by_stage', (SELECT coalesce(jsonb_object_agg(stage, n), '{}'::jsonb)
                         FROM (SELECT coalesce(stage, 'new') AS stage, count(*) AS n FROM ml GROUP BY 1) s),
    'call_recaps', (SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM (
                      SELECT ml.name AS lead, ml.company, calls.duration_sec, ca.summary_short AS summary
                        FROM calls
                        JOIN call_analyses ca ON ca.call_session_id = calls.id
                        LEFT JOIN ml ON ml.id = calls.lead_id
                       WHERE ca.summary_short IS NOT NULL
                       ORDER BY calls.duration_sec DESC NULLS LAST LIMIT 3) r),
    'reply_summaries', (SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM (
                          SELECT ml.name AS lead, ml.company, items.intent, items.metadata_json->>'ai_summary' AS summary
                            FROM items JOIN ml ON ml.id = items.lead_id
                           WHERE items.event_type = 'email_inbound'
                             AND items.intent IS DISTINCT FROM 'ooo_reply'
                             AND items.metadata_json->>'ai_summary' IS NOT NULL
                           ORDER BY (items.intent IN ('book_meeting', 'calendar_accept', 'meeting_confirmation', 'pricing', 'partnership')) DESC,
                                    items.occurred_at DESC
                           LIMIT 3) r)
  ) INTO v_result;

  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.pilot_report(uuid, timestamptz, timestamptz, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pilot_report(uuid, timestamptz, timestamptz, uuid[]) TO authenticated, service_role;
