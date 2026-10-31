-- ═══════════════════════════════════════════════════════════════════
-- Checks for 20261031120000_pilot_report.sql: each number counts only this
-- workspace, only the requested week and, when scoped, only the rep's own leads
-- and calls (never the client admin's own pipeline). Only admins can read it.
-- ═══════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on

INSERT INTO public.workspaces (id, name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Pilot'),
  ('00000000-0000-0000-0000-0000000000a2', 'Other');
INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000a01', 'admin'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000a02', 'rep');
-- b01/b02 = the rep's (a02) outreach leads; b04 = the admin's (a01) own deal.
INSERT INTO public.leads (id, workspace_id, owner_user_id, name, company, email, stage, linkedin_connected_at) VALUES
  ('00000000-0000-0000-0000-000000000b01', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000a02', 'Ann', 'Acme', 'ann@acme.example', 'engaged', '2026-11-03'),
  ('00000000-0000-0000-0000-000000000b02', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000a02', 'Bob', 'Beta', 'bob@beta.example', NULL, NULL),
  ('00000000-0000-0000-0000-000000000b03', '00000000-0000-0000-0000-0000000000a2', NULL, 'Zed', 'Other', 'zed@x.example', 'new', '2026-11-03'),
  ('00000000-0000-0000-0000-000000000b04', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000a01', 'Cleo', 'Costco', 'cleo@costco.example', 'closing', '2026-11-03');
INSERT INTO public.campaigns (id, workspace_id, name, status) VALUES
  ('00000000-0000-0000-0000-000000000c01', '00000000-0000-0000-0000-0000000000a1', 'Pilot seq', 'active');
INSERT INTO public.campaign_enrollment (id, campaign_id, lead_id, status, bounced_at) VALUES
  ('00000000-0000-0000-0000-000000000e01', '00000000-0000-0000-0000-000000000c01', '00000000-0000-0000-0000-000000000b01', 'active', NULL),
  ('00000000-0000-0000-0000-000000000e02', '00000000-0000-0000-0000-000000000c01', '00000000-0000-0000-0000-000000000b02', 'stopped', '2026-11-04');
INSERT INTO public.campaign_touch (enrollment_id, campaign_id, lead_id, step_number, channel, status, call_outcome, sent_at, eligible_at) VALUES
  -- LinkedIn done in the week, and one the week before (excluded)
  ('00000000-0000-0000-0000-000000000e01', '00000000-0000-0000-0000-000000000c01', '00000000-0000-0000-0000-000000000b01', 1, 'linkedin', 'sent', NULL, '2026-11-03', '2026-11-03'),
  ('00000000-0000-0000-0000-000000000e02', '00000000-0000-0000-0000-000000000c01', '00000000-0000-0000-0000-000000000b02', 1, 'linkedin', 'sent', NULL, '2026-10-28', '2026-10-28'),
  -- Three "Got them" taps in the week → beats the 1 long call
  ('00000000-0000-0000-0000-000000000e01', '00000000-0000-0000-0000-000000000c01', '00000000-0000-0000-0000-000000000b01', 2, 'voice', 'sent', 'got_them', '2026-11-04', '2026-11-04'),
  ('00000000-0000-0000-0000-000000000e01', '00000000-0000-0000-0000-000000000c01', '00000000-0000-0000-0000-000000000b01', 3, 'voice', 'sent', 'got_them', '2026-11-05', '2026-11-05'),
  ('00000000-0000-0000-0000-000000000e02', '00000000-0000-0000-0000-000000000c01', '00000000-0000-0000-0000-000000000b02', 2, 'voice', 'sent', 'got_them', '2026-11-05', '2026-11-05'),
  -- Approve card overdue > 2 days at the end of the week
  ('00000000-0000-0000-0000-000000000e01', '00000000-0000-0000-0000-000000000c01', '00000000-0000-0000-0000-000000000b01', 4, 'email', 'queued', NULL, NULL, '2026-11-04');
INSERT INTO public.lead_timeline_items (workspace_id, lead_id, event_type, intent, metadata_json, occurred_at, dedupe_key) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b01', 'email_outbound', NULL, NULL, '2026-11-03', 'o1'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b02', 'email_outbound', NULL, NULL, '2026-11-03', 'o2'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b02', 'email_outbound', NULL, NULL, '2026-10-30', 'o3'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b01', 'email_inbound', 'book_meeting', '{"ai_summary":"Wants a demo next week"}', '2026-11-05', 'i1'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b01', 'email_inbound', 'not_sure', NULL, '2026-11-06', 'i2'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b02', 'email_inbound', 'ooo_reply', '{"ai_summary":"Away"}', '2026-11-05', 'i3'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000b03', 'email_outbound', NULL, NULL, '2026-11-03', 'x1'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b04', 'email_outbound', NULL, NULL, '2026-11-04', 'c1'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b04', 'email_inbound', 'pricing', '{"ai_summary":"Admin deal"}', '2026-11-05', 'c2');
INSERT INTO public.call_sessions (id, workspace_id, lead_id, agent_user_id, direction, duration_sec, created_at) VALUES
  ('00000000-0000-0000-0000-000000000f01', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b01', '00000000-0000-0000-0000-000000000a02', 'outbound', 240, '2026-11-04'),
  ('00000000-0000-0000-0000-000000000f02', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b02', '00000000-0000-0000-0000-000000000a02', 'outbound', 12, '2026-11-05'),
  ('00000000-0000-0000-0000-000000000f03', '00000000-0000-0000-0000-0000000000a1', NULL, '00000000-0000-0000-0000-000000000a02', 'inbound', 300, '2026-11-05'),
  ('00000000-0000-0000-0000-000000000f04', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000b03', NULL, 'outbound', 500, '2026-11-05'),
  ('00000000-0000-0000-0000-000000000f05', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b04', '00000000-0000-0000-0000-000000000a01', 'outbound', 900, '2026-11-05');
INSERT INTO public.call_analyses (call_session_id, summary_short) VALUES
  ('00000000-0000-0000-0000-000000000f01', 'Uses armored pickup twice a week; open to a safe trial');

-- 1. The rep's numbers for the week of 2–9 Nov, read as the admin. The admin's own
--    deal (b04: an email, a pricing reply, a 15-minute call) must not appear.
SELECT set_config('test.uid', '00000000-0000-0000-0000-000000000a01', false);
DO $$
DECLARE r jsonb := public.pilot_report('00000000-0000-0000-0000-0000000000a1', '2026-11-02', '2026-11-09',
                                       ARRAY['00000000-0000-0000-0000-000000000a02']::uuid[]);
BEGIN
  IF (r->>'emails_sent')::int      <> 2 THEN RAISE EXCEPTION 'emails_sent %', r->>'emails_sent'; END IF;
  IF (r->>'replies')::int          <> 1 THEN RAISE EXCEPTION 'replies % (OOO must not count)', r->>'replies'; END IF;
  IF (r->>'positive_replies')::int <> 1 THEN RAISE EXCEPTION 'positive_replies %', r->>'positive_replies'; END IF;
  IF (r->>'bounces')::int          <> 1 THEN RAISE EXCEPTION 'bounces %', r->>'bounces'; END IF;
  IF (r->>'linkedin_done')::int    <> 1 THEN RAISE EXCEPTION 'linkedin_done %', r->>'linkedin_done'; END IF;
  IF (r->>'linkedin_accepted')::int <> 1 THEN RAISE EXCEPTION 'linkedin_accepted % (other workspace leaked?)', r->>'linkedin_accepted'; END IF;
  IF (r->>'calls_dialled')::int    <> 2 THEN RAISE EXCEPTION 'calls_dialled % (inbound / other ws must not count)', r->>'calls_dialled'; END IF;
  IF (r->>'conversations')::int    <> 1 THEN RAISE EXCEPTION 'conversations %', r->>'conversations'; END IF;
  IF (r->>'calls_answered')::int   <> 3 THEN RAISE EXCEPTION 'calls_answered %', r->>'calls_answered'; END IF;
  IF (r->>'meetings_booked')::int  <> 1 THEN RAISE EXCEPTION 'meetings_booked %', r->>'meetings_booked'; END IF;
  IF (r->>'waiting_on_rep')::int   <> 1 THEN RAISE EXCEPTION 'waiting_on_rep %', r->>'waiting_on_rep'; END IF;
  IF (r->'leads_by_stage'->>'new')::int <> 1 OR (r->'leads_by_stage'->>'engaged')::int <> 1 THEN
    RAISE EXCEPTION 'leads_by_stage %', r->'leads_by_stage'; END IF;
  IF jsonb_array_length(r->'call_recaps') <> 1 THEN RAISE EXCEPTION 'call_recaps %', r->'call_recaps'; END IF;
  IF r->'reply_summaries'->0->>'summary' <> 'Wants a demo next week' THEN
    RAISE EXCEPTION 'reply_summaries % (positive first, OOO excluded)', r->'reply_summaries'; END IF;
END $$;

-- 1b. Unscoped (NULL) = whole workspace, so the admin's deal counts too.
DO $$
DECLARE r jsonb := public.pilot_report('00000000-0000-0000-0000-0000000000a1', '2026-11-02', '2026-11-09');
BEGIN
  IF (r->>'emails_sent')::int <> 3 OR (r->>'positive_replies')::int <> 2 OR (r->>'calls_dialled')::int <> 3 THEN
    RAISE EXCEPTION 'unscoped report %', r; END IF;
END $$;

-- 2. A rep (non-admin) is refused.
SELECT set_config('test.uid', '00000000-0000-0000-0000-000000000a02', false);
DO $$ BEGIN
  PERFORM public.pilot_report('00000000-0000-0000-0000-0000000000a1', '2026-11-02', '2026-11-09');
  RAISE EXCEPTION 'expected a non-admin to be refused';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;

-- 3. anon cannot execute it at all.
DO $$ BEGIN
  IF has_function_privilege('anon', 'public.pilot_report(uuid, timestamptz, timestamptz, uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not be able to run pilot_report';
  END IF;
END $$;
SELECT set_config('test.uid', '', false);
