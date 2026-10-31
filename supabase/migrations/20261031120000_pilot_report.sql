-- ═══════════════════════════════════════════════════════════════════
-- pilot_report(workspace, from, to) — the ONE source of numbers for a client
-- pilot report (the Monday email AND the Pilot page read this, so they always
-- agree). Read-only. Admins of the workspace (or the service role, which has no
-- auth.uid()) may call it; anon is revoked below.
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

CREATE OR REPLACE FUNCTION public.pilot_report(_workspace_id uuid, _from timestamptz, _to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_conversations int;
  v_got_them int;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_workspace_admin(_workspace_id, auth.uid()) THEN
    RAISE EXCEPTION 'Only workspace admins can view the pilot report' USING ERRCODE = '42501';
  END IF;

  SELECT count(*) FILTER (WHERE cs.duration_sec >= 60) INTO v_conversations
    FROM call_sessions cs
   WHERE cs.workspace_id = _workspace_id AND cs.direction = 'outbound'
     AND cs.created_at >= _from AND cs.created_at < _to;

  SELECT count(*) INTO v_got_them
    FROM campaign_touch t JOIN campaigns c ON c.id = t.campaign_id
   WHERE c.workspace_id = _workspace_id AND t.channel = 'voice' AND t.call_outcome = 'got_them'
     AND t.sent_at >= _from AND t.sent_at < _to;

  SELECT jsonb_build_object(
    'from', _from, 'to', _to,
    'emails_sent', (SELECT count(*) FROM lead_timeline_items
                     WHERE workspace_id = _workspace_id AND event_type = 'email_outbound'
                       AND occurred_at >= _from AND occurred_at < _to),
    'replies', (SELECT count(DISTINCT lead_id) FROM lead_timeline_items
                 WHERE workspace_id = _workspace_id AND event_type = 'email_inbound'
                   AND intent IS DISTINCT FROM 'ooo_reply'
                   AND occurred_at >= _from AND occurred_at < _to),
    'positive_replies', (SELECT count(DISTINCT lead_id) FROM lead_timeline_items
                          WHERE workspace_id = _workspace_id AND event_type = 'email_inbound'
                            AND intent IN ('book_meeting', 'calendar_accept', 'meeting_confirmation', 'pricing', 'partnership')
                            AND occurred_at >= _from AND occurred_at < _to),
    'bounces', (SELECT count(*) FROM campaign_enrollment e JOIN campaigns c ON c.id = e.campaign_id
                 WHERE c.workspace_id = _workspace_id AND e.bounced_at >= _from AND e.bounced_at < _to),
    'linkedin_done', (SELECT count(*) FROM campaign_touch t JOIN campaigns c ON c.id = t.campaign_id
                       WHERE c.workspace_id = _workspace_id AND t.channel = 'linkedin' AND t.status = 'sent'
                         AND t.sent_at >= _from AND t.sent_at < _to),
    'linkedin_accepted', (SELECT count(*) FROM leads
                           WHERE workspace_id = _workspace_id
                             AND linkedin_connected_at >= _from AND linkedin_connected_at < _to),
    'calls_dialled', (SELECT count(*) FROM call_sessions
                       WHERE workspace_id = _workspace_id AND direction = 'outbound'
                         AND created_at >= _from AND created_at < _to),
    'conversations', v_conversations,
    'calls_answered', greatest(v_conversations, v_got_them),
    'meetings_booked', (SELECT count(DISTINCT lead_id) FROM lead_timeline_items
                         WHERE workspace_id = _workspace_id
                           AND (event_type = 'meeting'
                                OR (event_type = 'email_inbound' AND intent IN ('book_meeting', 'calendar_accept', 'meeting_confirmation')))
                           AND occurred_at >= _from AND occurred_at < _to),
    'waiting_on_rep', (SELECT count(*) FROM campaign_touch t JOIN campaigns c ON c.id = t.campaign_id
                        WHERE c.workspace_id = _workspace_id AND c.status = 'active'
                          AND t.status = 'queued' AND t.eligible_at < _to - interval '2 days'),
    'leads_by_stage', (SELECT coalesce(jsonb_object_agg(stage, n), '{}'::jsonb)
                         FROM (SELECT coalesce(stage, 'new') AS stage, count(*) AS n FROM leads
                                WHERE workspace_id = _workspace_id GROUP BY 1) s),
    'call_recaps', (SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM (
                      SELECT l.name AS lead, l.company, cs.duration_sec, ca.summary_short AS summary
                        FROM call_sessions cs
                        JOIN call_analyses ca ON ca.call_session_id = cs.id
                        LEFT JOIN leads l ON l.id = cs.lead_id
                       WHERE cs.workspace_id = _workspace_id AND cs.created_at >= _from AND cs.created_at < _to
                         AND ca.summary_short IS NOT NULL
                       ORDER BY cs.duration_sec DESC NULLS LAST LIMIT 3) r),
    'reply_summaries', (SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM (
                          SELECT l.name AS lead, l.company, i.intent, i.metadata_json->>'ai_summary' AS summary
                            FROM lead_timeline_items i
                            LEFT JOIN leads l ON l.id = i.lead_id
                           WHERE i.workspace_id = _workspace_id AND i.event_type = 'email_inbound'
                             AND i.intent IS DISTINCT FROM 'ooo_reply'
                             AND i.metadata_json->>'ai_summary' IS NOT NULL
                             AND i.occurred_at >= _from AND i.occurred_at < _to
                           ORDER BY (i.intent IN ('book_meeting', 'calendar_accept', 'meeting_confirmation', 'pricing', 'partnership')) DESC,
                                    i.occurred_at DESC
                           LIMIT 3) r)
  ) INTO v_result;

  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.pilot_report(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pilot_report(uuid, timestamptz, timestamptz) TO authenticated, service_role;
