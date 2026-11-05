-- ═══════════════════════════════════════════════════════════════════
-- Checks for 20261105120000_compute_manager_analytics_sql.sql: every
-- manager_views metric for a hand-computed rep, workspace scoping (a rep in two
-- workspaces never gets the other workspace's leads), the 10-entry ghost list,
-- and that a re-run updates rows in place.
-- ═══════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on

-- W1/W2: rep R is in both. A = admin in W1 with no leads. M = plain member (no row).
INSERT INTO public.workspaces (id, name) VALUES
  ('dd000000-0000-0000-0000-0000000000a1', 'MA one'),
  ('dd000000-0000-0000-0000-0000000000a2', 'MA two'),
  ('dd000000-0000-0000-0000-0000000000a3', 'MA cap');
INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('dd000000-0000-0000-0000-0000000000a1', 'dd000000-0000-0000-0000-000000000001', 'rep'),
  ('dd000000-0000-0000-0000-0000000000a1', 'dd000000-0000-0000-0000-000000000002', 'admin'),
  ('dd000000-0000-0000-0000-0000000000a1', 'dd000000-0000-0000-0000-000000000003', 'member'),
  ('dd000000-0000-0000-0000-0000000000a2', 'dd000000-0000-0000-0000-000000000001', 'rep'),
  ('dd000000-0000-0000-0000-0000000000a3', 'dd000000-0000-0000-0000-000000000004', 'rep');

INSERT INTO public.leads (id, workspace_id, owner_user_id, name, stage, status, deal_outlook, last_inbound_at, last_outbound_at) VALUES
  -- Ann: open, waiting on the rep 30 days → high ghost risk; latest message inbound → needs reply
  ('dd000000-0000-0000-0000-000000000b01', 'dd000000-0000-0000-0000-0000000000a1', 'dd000000-0000-0000-0000-000000000001',
   'Ann', 'engaged', 'open', 'positive', now() - interval '20 days', now() - interval '30 days'),
  -- Bob: closed → no needs-reply, no ghost, not active. Blank stage/outlook → new/neutral
  ('dd000000-0000-0000-0000-000000000b02', 'dd000000-0000-0000-0000-0000000000a1', 'dd000000-0000-0000-0000-000000000001',
   'Bob', NULL, 'closed', NULL, now() - interval '20 days', now() - interval '30 days'),
  -- Cy: 8 days since outbound → medium
  ('dd000000-0000-0000-0000-000000000b03', 'dd000000-0000-0000-0000-0000000000a1', 'dd000000-0000-0000-0000-000000000001',
   'Cy', 'engaged', 'new', NULL, now() - interval '1 day', now() - interval '8 days'),
  -- Dee: inbound, never an outbound → high
  ('dd000000-0000-0000-0000-000000000b04', 'dd000000-0000-0000-0000-0000000000a1', 'dd000000-0000-0000-0000-000000000001',
   'Dee', 'engaged', 'new', NULL, now() - interval '1 day', NULL),
  -- Zed: same rep, OTHER workspace → must never show in W1's row
  ('dd000000-0000-0000-0000-000000000b05', 'dd000000-0000-0000-0000-0000000000a2', 'dd000000-0000-0000-0000-000000000001',
   'Zed', 'closing', 'new', 'negative', now() - interval '1 day', NULL);

INSERT INTO public.interactions (lead_id, type, direction, source, occurred_at) VALUES
  -- Ann (gmail): gaps 30 and 120 min; ends inbound
  ('dd000000-0000-0000-0000-000000000b01', 'email_inbound',  'inbound',  'gmail', '2026-11-01 10:00+00'),
  ('dd000000-0000-0000-0000-000000000b01', 'email_outbound', 'outbound', 'gmail', '2026-11-01 10:30+00'),
  ('dd000000-0000-0000-0000-000000000b01', 'email_inbound',  'inbound',  'gmail', '2026-11-01 11:00+00'),
  ('dd000000-0000-0000-0000-000000000b01', 'email_outbound', 'outbound', 'gmail', '2026-11-01 13:00+00'),
  ('dd000000-0000-0000-0000-000000000b01', 'email_inbound',  'inbound',  'gmail', '2026-11-01 14:00+00'),
  -- Bob (no source → 'email'): gap 10; ends inbound but closed
  ('dd000000-0000-0000-0000-000000000b02', 'email_inbound',  'inbound',  NULL,    '2026-11-01 08:00+00'),
  ('dd000000-0000-0000-0000-000000000b02', 'email_outbound', 'outbound', NULL,    '2026-11-01 08:10+00'),
  ('dd000000-0000-0000-0000-000000000b02', 'email_inbound',  'inbound',  NULL,    '2026-11-01 09:00+00'),
  -- Cy (whatsapp): a note (neither direction), then gap 60; ends outbound
  ('dd000000-0000-0000-0000-000000000b03', 'note',           NULL,       'whatsapp', '2026-11-01 14:30+00'),
  ('dd000000-0000-0000-0000-000000000b03', 'whatsapp',       'inbound',  'whatsapp', '2026-11-01 15:00+00'),
  ('dd000000-0000-0000-0000-000000000b03', 'whatsapp',       'outbound', 'whatsapp', '2026-11-01 16:00+00'),
  -- Zed (other workspace)
  ('dd000000-0000-0000-0000-000000000b05', 'email_inbound',  'inbound',  'gmail', '2026-11-01 12:00+00');

-- Cap: 3 high + 12 medium ghost leads → 3 highs + 7 mediums listed.
INSERT INTO public.leads (workspace_id, owner_user_id, name, stage, last_inbound_at, last_outbound_at)
SELECT 'dd000000-0000-0000-0000-0000000000a3', 'dd000000-0000-0000-0000-000000000004',
       'cap' || g, 'new', now() - interval '1 day',
       CASE WHEN g <= 3 THEN now() - interval '20 days' ELSE now() - (8 + g) * interval '1 hour' - interval '8 days' END
FROM generate_series(1, 15) g;

DO $$
DECLARE
  n int;
  r public.manager_views;
BEGIN
  n := public.compute_manager_analytics_sql('dd000000-0000-0000-0000-0000000000a1');
  IF n <> 2 THEN RAISE EXCEPTION 'W1 should write 2 rows (rep + admin, not member), wrote %', n; END IF;

  SELECT * INTO r FROM public.manager_views
  WHERE workspace_id = 'dd000000-0000-0000-0000-0000000000a1' AND rep_user_id = 'dd000000-0000-0000-0000-000000000001';

  IF r.total_conversations <> 4 OR r.active_conversations <> 3 THEN
    RAISE EXCEPTION 'leads total/active: %/% (want 4/3)', r.total_conversations, r.active_conversations; END IF;
  IF r.total_messages_sent <> 4 OR r.total_messages_received <> 6 THEN
    RAISE EXCEPTION 'sent/received: %/% (want 4/6)', r.total_messages_sent, r.total_messages_received; END IF;
  -- gaps 10, 30, 60, 120 → avg 55, upper median 60
  IF r.avg_response_time_minutes <> 55 OR r.median_response_time_minutes <> 60 THEN
    RAISE EXCEPTION 'avg/median: %/% (want 55/60)', r.avg_response_time_minutes, r.median_response_time_minutes; END IF;
  IF r.needs_reply_count <> 1 THEN RAISE EXCEPTION 'needs_reply %, want 1', r.needs_reply_count; END IF;
  IF r.stage_distribution <> '{"engaged":3,"new":1}'::jsonb THEN
    RAISE EXCEPTION 'stage_distribution %', r.stage_distribution; END IF;
  IF r.top_topics <> '[{"topic":"engaged","count":3},{"topic":"new","count":1}]'::jsonb THEN
    RAISE EXCEPTION 'top_topics %', r.top_topics; END IF;
  IF r.sentiment_distribution <> '{"positive":1,"neutral":3}'::jsonb THEN
    RAISE EXCEPTION 'sentiment_distribution %', r.sentiment_distribution; END IF;
  IF r.channel_metrics <> '{"gmail":{"sent":2,"received":3,"conversations":1},
                            "email":{"sent":1,"received":2,"conversations":1},
                            "whatsapp":{"sent":1,"received":2,"conversations":1}}'::jsonb THEN
    RAISE EXCEPTION 'channel_metrics %', r.channel_metrics; END IF;
  IF r.high_ghost_risk_count <> 2 OR r.medium_ghost_risk_count <> 1 THEN
    RAISE EXCEPTION 'ghost high/medium: %/% (want 2/1)', r.high_ghost_risk_count, r.medium_ghost_risk_count; END IF;
  IF (SELECT array_agg(e->>'summary' ORDER BY e->>'summary') FROM jsonb_array_elements(r.ghost_risk_contacts) e)
     <> ARRAY['Ann','Cy','Dee'] THEN
    RAISE EXCEPTION 'ghost contacts %', r.ghost_risk_contacts; END IF;
  IF r.objection_frequency <> '{}'::jsonb OR r.urgency_distribution <> '{}'::jsonb THEN
    RAISE EXCEPTION 'objection/urgency should stay {}'; END IF;

  -- Workspace scoping: Zed (W2) is nowhere in W1's row.
  IF r::text LIKE '%Zed%' OR r.stage_distribution ? 'closing' THEN
    RAISE EXCEPTION 'W2 lead leaked into W1 row: %', r; END IF;

  -- Admin with no leads: zeroed row.
  SELECT * INTO r FROM public.manager_views
  WHERE workspace_id = 'dd000000-0000-0000-0000-0000000000a1' AND rep_user_id = 'dd000000-0000-0000-0000-000000000002';
  IF r.total_conversations <> 0 OR r.stage_distribution <> '{}'::jsonb OR r.ghost_risk_contacts <> '[]'::jsonb
     OR r.avg_response_time_minutes <> 0 THEN
    RAISE EXCEPTION 'admin row not zeroed: %', r; END IF;

  -- W2 row for the same rep counts only Zed.
  PERFORM public.compute_manager_analytics_sql('dd000000-0000-0000-0000-0000000000a2');
  SELECT * INTO r FROM public.manager_views
  WHERE workspace_id = 'dd000000-0000-0000-0000-0000000000a2' AND rep_user_id = 'dd000000-0000-0000-0000-000000000001';
  IF r.total_conversations <> 1 OR r.total_messages_received <> 1 OR r.stage_distribution <> '{"closing":1}'::jsonb THEN
    RAISE EXCEPTION 'W2 row wrong: %', r; END IF;

  -- Ghost list cap: every high, mediums only up to 10 entries.
  PERFORM public.compute_manager_analytics_sql('dd000000-0000-0000-0000-0000000000a3');
  SELECT * INTO r FROM public.manager_views WHERE workspace_id = 'dd000000-0000-0000-0000-0000000000a3';
  IF r.high_ghost_risk_count <> 3 OR r.medium_ghost_risk_count <> 12
     OR jsonb_array_length(r.ghost_risk_contacts) <> 10
     OR (SELECT count(*) FROM jsonb_array_elements(r.ghost_risk_contacts) e WHERE e->>'risk' = 'high') <> 3 THEN
    RAISE EXCEPTION 'ghost cap wrong: %/% %', r.high_ghost_risk_count, r.medium_ghost_risk_count, r.ghost_risk_contacts; END IF;

  -- Re-run updates in place: the rep answers Ann → needs_reply drops to 0, no new rows.
  INSERT INTO public.interactions (lead_id, type, direction, source, occurred_at) VALUES
    ('dd000000-0000-0000-0000-000000000b01', 'email_outbound', 'outbound', 'gmail', '2026-11-01 14:05+00');
  PERFORM public.compute_manager_analytics_sql();  -- NULL = every workspace
  IF (SELECT count(*) FROM public.manager_views WHERE workspace_id = 'dd000000-0000-0000-0000-0000000000a1') <> 2 THEN
    RAISE EXCEPTION 're-run duplicated W1 rows'; END IF;
  SELECT * INTO r FROM public.manager_views
  WHERE workspace_id = 'dd000000-0000-0000-0000-0000000000a1' AND rep_user_id = 'dd000000-0000-0000-0000-000000000001';
  IF r.needs_reply_count <> 0 OR r.total_messages_sent <> 5 THEN
    RAISE EXCEPTION 're-run did not update: needs_reply %, sent %', r.needs_reply_count, r.total_messages_sent; END IF;

  -- Only the service role may run it.
  IF has_function_privilege('authenticated', 'public.compute_manager_analytics_sql(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.compute_manager_analytics_sql(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.compute_manager_analytics_sql(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'EXECUTE grants wrong'; END IF;

  RAISE NOTICE 'manager_analytics: all checks passed';
END $$;
