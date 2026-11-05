-- ═══════════════════════════════════════════════════════════════════
-- manager_views as ONE SQL aggregate (DB load plan, Unit C).
--
-- compute-manager-analytics used to loop over every (workspace, rep/admin)
-- member and make 3 reads + 1 upsert each: ~47 s per run for 19 rows. This
-- function computes every row in one INSERT … ON CONFLICT; the edge function
-- just calls it.
--
-- Same metrics and rules as the old TypeScript, with two fixes:
--   1. Leads are scoped to the row's WORKSPACE (owner AND workspace). The old
--      code filtered by owner only, so a rep in two workspaces had both
--      workspaces' leads (and their names, in ghost_risk_contacts) in each row.
--   2. No URL / 1000-row limits. The old code passed every lead id in the
--      request URL; for a 381-lead rep that request failed silently and the row
--      showed 0 messages.
--
-- Still reads `interactions` (legacy), exactly like the old code.
-- ponytail: moving the message source to lead_timeline_items is a separate change.
-- Rows for people who are no longer members are not deleted (unchanged).
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.compute_manager_analytics_sql(_workspace_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  WITH reps AS (
    SELECT DISTINCT wm.workspace_id, wm.user_id AS rep_user_id
    FROM workspace_members wm
    WHERE wm.role::text IN ('rep', 'admin')
      AND (_workspace_id IS NULL OR wm.workspace_id = _workspace_id)
  ),
  rl AS (
    SELECT r.workspace_id, r.rep_user_id, l.id AS lead_id, l.name,
           (l.status IS DISTINCT FROM 'closed') AS is_open,
           COALESCE(l.stage, 'new') AS stage,
           COALESCE(l.deal_outlook, 'neutral') AS outlook,
           l.last_inbound_at, l.last_outbound_at
    FROM reps r
    JOIN leads l ON l.owner_user_id = r.rep_user_id AND l.workspace_id = r.workspace_id
  ),
  msgs AS (
    SELECT rl.workspace_id, rl.rep_user_id, rl.lead_id, rl.is_open,
           COALESCE(i.source, 'email') AS ch,
           i.occurred_at,
           (COALESCE(i.type, '') = 'email_outbound' OR COALESCE(i.direction, '') = 'outbound') AS is_out,
           (COALESCE(i.type, '') = 'email_inbound'  OR COALESCE(i.direction, '') = 'inbound')  AS is_in,
           LAG(COALESCE(i.type, '') = 'email_inbound' OR COALESCE(i.direction, '') = 'inbound')
             OVER w AS prev_in,
           LAG(i.occurred_at) OVER w AS prev_at,
           ROW_NUMBER() OVER (PARTITION BY rl.workspace_id, rl.rep_user_id, rl.lead_id
                              ORDER BY i.occurred_at DESC, i.id DESC) AS rn_desc
    FROM rl
    JOIN interactions i ON i.lead_id = rl.lead_id
    -- ponytail: ties on occurred_at are broken by id (the old code took whatever
    -- order PostgREST returned).
    WINDOW w AS (PARTITION BY rl.workspace_id, rl.rep_user_id, rl.lead_id
                 ORDER BY i.occurred_at, i.id)
  ),
  totals AS (
    SELECT workspace_id, rep_user_id,
           COUNT(*) FILTER (WHERE is_out) AS sent,
           COUNT(*) FILTER (WHERE NOT is_out AND is_in) AS received,
           COUNT(*) FILTER (WHERE rn_desc = 1 AND is_in AND is_open) AS needs_reply
    FROM msgs GROUP BY 1, 2
  ),
  gaps AS (
    -- inbound immediately followed by outbound on the same lead, in minutes
    SELECT workspace_id, rep_user_id,
           EXTRACT(EPOCH FROM (occurred_at - prev_at)) / 60.0 AS g,
           ROW_NUMBER() OVER (PARTITION BY workspace_id, rep_user_id ORDER BY occurred_at - prev_at) AS rn,
           COUNT(*) OVER (PARTITION BY workspace_id, rep_user_id) AS cnt
    FROM msgs
    WHERE prev_in AND is_out
  ),
  rt AS (
    SELECT workspace_id, rep_user_id,
           ROUND(AVG(g)::numeric, 1)::float8 AS avg_rt,
           -- upper median, as before: sorted[floor(n/2)] (0-based)
           ROUND((MAX(g) FILTER (WHERE rn = cnt / 2 + 1))::numeric, 1)::float8 AS median_rt
    FROM gaps GROUP BY 1, 2
  ),
  ch_counts AS (
    SELECT workspace_id, rep_user_id, ch,
           COUNT(*) FILTER (WHERE is_out) AS sent,
           COUNT(*) FILTER (WHERE NOT is_out) AS received,
           COUNT(DISTINCT lead_id) AS conversations
    FROM msgs GROUP BY 1, 2, 3
  ),
  channels AS (
    SELECT workspace_id, rep_user_id,
           jsonb_object_agg(ch, jsonb_build_object('sent', sent, 'received', received,
                                                   'conversations', conversations)) AS j
    FROM ch_counts GROUP BY 1, 2
  ),
  stage_counts AS (
    SELECT workspace_id, rep_user_id, stage, COUNT(*) AS c FROM rl GROUP BY 1, 2, 3
  ),
  stages AS (
    SELECT workspace_id, rep_user_id,
           jsonb_object_agg(stage, c) AS dist,
           -- ponytail: equal counts are ordered by stage name (the old code kept
           -- first-seen order).
           (jsonb_agg(jsonb_build_object('topic', stage, 'count', c) ORDER BY c DESC, stage)
              FILTER (WHERE rk <= 10)) AS topics
    FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY workspace_id, rep_user_id
                                       ORDER BY c DESC, stage) AS rk
          FROM stage_counts) s
    GROUP BY 1, 2
  ),
  outlook_counts AS (
    SELECT workspace_id, rep_user_id, outlook, COUNT(*) AS c FROM rl GROUP BY 1, 2, 3
  ),
  outlooks AS (
    SELECT workspace_id, rep_user_id, jsonb_object_agg(outlook, c) AS dist
    FROM outlook_counts GROUP BY 1, 2
  ),
  lead_totals AS (
    SELECT workspace_id, rep_user_id,
           COUNT(*) AS total, COUNT(*) FILTER (WHERE is_open) AS active
    FROM rl GROUP BY 1, 2
  ),
  ghost AS (
    -- open leads waiting on the rep: last inbound newer than last outbound.
    -- No outbound ever counts as 999 days, as before.
    SELECT workspace_id, rep_user_id, lead_id, name, last_outbound_at,
           CASE WHEN last_outbound_at IS NULL OR last_outbound_at <= now() - interval '14 days' THEN 'high'
                ELSE 'medium' END AS risk
    FROM rl
    WHERE is_open
      AND last_inbound_at IS NOT NULL
      AND (last_outbound_at IS NULL OR last_inbound_at > last_outbound_at)
      AND (last_outbound_at IS NULL OR last_outbound_at <= now() - interval '7 days')
  ),
  ghost_ranked AS (
    SELECT g.*,
           COUNT(*) FILTER (WHERE risk = 'high') OVER (PARTITION BY workspace_id, rep_user_id) AS n_high,
           ROW_NUMBER() OVER (PARTITION BY workspace_id, rep_user_id, risk
                              ORDER BY last_outbound_at NULLS FIRST, lead_id) AS rk
    FROM ghost g
  ),
  ghosts AS (
    SELECT workspace_id, rep_user_id,
           COUNT(*) FILTER (WHERE risk = 'high') AS high,
           COUNT(*) FILTER (WHERE risk = 'medium') AS medium,
           -- Every high, then mediums while the list has fewer than 10 entries.
           -- ponytail: mediums fill the room left after ALL highs, most stale
           -- first (the old code interleaved them in row order).
           jsonb_agg(jsonb_build_object('contact_id', lead_id, 'summary', name, 'risk', risk)
                     ORDER BY risk, last_outbound_at NULLS FIRST, lead_id)
             FILTER (WHERE risk = 'high' OR rk <= 10 - n_high) AS contacts
    FROM ghost_ranked GROUP BY 1, 2
  )
  INSERT INTO manager_views AS mv (
    workspace_id, rep_user_id, computed_at,
    avg_response_time_minutes, median_response_time_minutes, needs_reply_count,
    stage_distribution, objection_frequency,
    high_ghost_risk_count, medium_ghost_risk_count, ghost_risk_contacts,
    channel_metrics, total_conversations, total_messages_sent, total_messages_received,
    active_conversations, sentiment_distribution, urgency_distribution, top_topics
  )
  SELECT r.workspace_id, r.rep_user_id, now(),
         COALESCE(rt.avg_rt, 0), COALESCE(rt.median_rt, 0), COALESCE(t.needs_reply, 0),
         COALESCE(s.dist, '{}'::jsonb), '{}'::jsonb,
         COALESCE(g.high, 0), COALESCE(g.medium, 0), COALESCE(g.contacts, '[]'::jsonb),
         COALESCE(c.j, '{}'::jsonb), COALESCE(lt.total, 0), COALESCE(t.sent, 0), COALESCE(t.received, 0),
         COALESCE(lt.active, 0), COALESCE(o.dist, '{}'::jsonb), '{}'::jsonb, COALESCE(s.topics, '[]'::jsonb)
  FROM reps r
  LEFT JOIN totals t       USING (workspace_id, rep_user_id)
  LEFT JOIN rt             USING (workspace_id, rep_user_id)
  LEFT JOIN channels c     USING (workspace_id, rep_user_id)
  LEFT JOIN stages s       USING (workspace_id, rep_user_id)
  LEFT JOIN outlooks o     USING (workspace_id, rep_user_id)
  LEFT JOIN lead_totals lt USING (workspace_id, rep_user_id)
  LEFT JOIN ghosts g       USING (workspace_id, rep_user_id)
  ON CONFLICT (workspace_id, rep_user_id) DO UPDATE SET
    computed_at                  = EXCLUDED.computed_at,
    avg_response_time_minutes    = EXCLUDED.avg_response_time_minutes,
    median_response_time_minutes = EXCLUDED.median_response_time_minutes,
    needs_reply_count            = EXCLUDED.needs_reply_count,
    stage_distribution           = EXCLUDED.stage_distribution,
    objection_frequency          = EXCLUDED.objection_frequency,
    high_ghost_risk_count        = EXCLUDED.high_ghost_risk_count,
    medium_ghost_risk_count      = EXCLUDED.medium_ghost_risk_count,
    ghost_risk_contacts          = EXCLUDED.ghost_risk_contacts,
    channel_metrics              = EXCLUDED.channel_metrics,
    total_conversations          = EXCLUDED.total_conversations,
    total_messages_sent          = EXCLUDED.total_messages_sent,
    total_messages_received      = EXCLUDED.total_messages_received,
    active_conversations         = EXCLUDED.active_conversations,
    sentiment_distribution       = EXCLUDED.sentiment_distribution,
    urgency_distribution         = EXCLUDED.urgency_distribution,
    top_topics                   = EXCLUDED.top_topics;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.compute_manager_analytics_sql(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_manager_analytics_sql(uuid) TO service_role;
