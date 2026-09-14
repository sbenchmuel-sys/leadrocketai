-- ═══════════════════════════════════════════════════════════════════
-- Unit G-B: an inbound reply must take EVERY matching lead row out of
-- automation-executor's candidate set — with or without an automation_log row.
--
-- THE BUG: the webhook's pause looked up automation_log first and only touched
-- the LEAD if it found an account-scoped log row. A lead armed but not yet sent
-- (a queued first touch — the normal state) has no log row, so the pause
-- early-returned and the lead stayed a live send candidate after the contact
-- replied. That was true for the primary lead and for every duplicate.
--
-- WHAT THIS PROVES, on real rows: after `pause_leads_on_inbound` (the real
-- production write, created by the migration this suite applies), NO passed
-- lead satisfies automation-executor's candidate predicate. The predicate is
-- copied below verbatim from automation-executor/index.ts's candidate query;
-- the assertion is on the LEAD ROW'S STATE, not on any call.
-- ═══════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on

INSERT INTO public.workspaces (id, name) VALUES ('00000000-0000-0000-0000-000000009999', 'WS D');

-- Three duplicates of one contact, all ARMED (automation_mode set, due
-- eligible_at, needs_action true, active status):
--   armed_with_log : has a pending automation_log row (the only case the old
--                    routine handled)
--   armed_no_log   : armed but never sent — NO log row (the hole)
--   armed_legacy   : a log row with NO mail_account_id (the old routine paused
--                    the log and returned WITHOUT touching the lead)
INSERT INTO public.leads (id, workspace_id, name, email, automation_mode, needs_action, eligible_at, next_action_key, status) VALUES
  ('00000000-0000-0000-0000-00000000b101', '00000000-0000-0000-0000-000000009999', 'armed_with_log', 'dup@example.com', 'auto', true, now() - interval '1 hour', 'send_pre_2', 'active'),
  ('00000000-0000-0000-0000-00000000b102', '00000000-0000-0000-0000-000000009999', 'armed_no_log',   'dup@example.com', 'auto', true, now() - interval '1 hour', 'send_pre_2', 'active'),
  ('00000000-0000-0000-0000-00000000b103', '00000000-0000-0000-0000-000000009999', 'armed_legacy',   'dup@example.com', 'auto', true, now() - interval '1 hour', 'send_pre_2', 'active');
INSERT INTO public.automation_log (lead_id, mail_account_id, status, action_key) VALUES
  ('00000000-0000-0000-0000-00000000b101', '00000000-0000-0000-0000-00000000a0a0', 'pending', 'send_pre_2'),
  ('00000000-0000-0000-0000-00000000b103', NULL,                                   'pending', 'send_pre_2');

-- automation-executor's candidate predicate, verbatim.
CREATE OR REPLACE FUNCTION pg_temp.is_send_candidate(p_lead uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.leads
     WHERE id = p_lead
       AND needs_action = true
       AND eligible_at IS NOT NULL
       AND automation_mode IS NOT NULL
       AND eligible_at <= now()
       AND status IN ('active', 'new')
       AND unsubscribed = false
       AND manual_mode = false
       AND next_action_key IS DISTINCT FROM 'ooo_return_followup'
  )
$$;

-- 0. CONTROL: before the pause, all three ARE candidates. (If this fails the
--    test cannot detect the bug and must not be trusted.)
DO $$ BEGIN
  IF NOT (pg_temp.is_send_candidate('00000000-0000-0000-0000-00000000b101')
      AND pg_temp.is_send_candidate('00000000-0000-0000-0000-00000000b102')
      AND pg_temp.is_send_candidate('00000000-0000-0000-0000-00000000b103'))
  THEN RAISE EXCEPTION 'control failed: the seeded leads are not send candidates, so this test proves nothing'; END IF;
END $$;

-- 1. THE REPLY. One call, every matching row — exactly what the webhook does.
SELECT public.pause_leads_on_inbound(
  ARRAY['00000000-0000-0000-0000-00000000b101',
        '00000000-0000-0000-0000-00000000b102',
        '00000000-0000-0000-0000-00000000b103']::uuid[],
  'reply_received',
  true
);

-- 2. THE ASSERTION, on state: none of them is a send candidate any more —
--    including the one with NO log row and the one with a LEGACY log row.
DO $$ BEGIN
  IF pg_temp.is_send_candidate('00000000-0000-0000-0000-00000000b101')
  THEN RAISE EXCEPTION 'armed_with_log is still a send candidate after the reply'; END IF;
  IF pg_temp.is_send_candidate('00000000-0000-0000-0000-00000000b102')
  THEN RAISE EXCEPTION 'armed_no_log is still a send candidate after the reply — the customer keeps getting emailed'; END IF;
  IF pg_temp.is_send_candidate('00000000-0000-0000-0000-00000000b103')
  THEN RAISE EXCEPTION 'armed_legacy is still a send candidate after the reply'; END IF;

  -- Both halves of the executor's gate are closed, not just one.
  IF EXISTS (SELECT 1 FROM public.leads WHERE email = 'dup@example.com' AND (needs_action OR eligible_at IS NOT NULL))
  THEN RAISE EXCEPTION 'a duplicate still has needs_action or eligible_at set'; END IF;

  -- Bookkeeping: every live log row is paused.
  IF EXISTS (SELECT 1 FROM public.automation_log WHERE lead_id IN
    ('00000000-0000-0000-0000-00000000b101','00000000-0000-0000-0000-00000000b103') AND status <> 'paused')
  THEN RAISE EXCEPTION 'a live automation_log row was not paused'; END IF;
END $$;

-- 3. The OOO-kept-actionable mode (p_clear_action = false): the human prompt
--    survives, but the send is still defused.
INSERT INTO public.leads (id, workspace_id, name, email, automation_mode, needs_action, eligible_at, next_action_key, status) VALUES
  ('00000000-0000-0000-0000-00000000b104', '00000000-0000-0000-0000-000000009999', 'ooo_question', 'ooo@example.com', 'auto', true, now() - interval '1 hour', 'reply_now', 'active');
DO $$ BEGIN
  IF NOT pg_temp.is_send_candidate('00000000-0000-0000-0000-00000000b104')
  THEN RAISE EXCEPTION 'control failed for the OOO case'; END IF;
END $$;
SELECT public.pause_leads_on_inbound(ARRAY['00000000-0000-0000-0000-00000000b104']::uuid[], 'ooo_reply', false);
DO $$ BEGIN
  IF pg_temp.is_send_candidate('00000000-0000-0000-0000-00000000b104')
  THEN RAISE EXCEPTION 'OOO-kept-actionable lead is still a send candidate'; END IF;
  IF (SELECT needs_action FROM public.leads WHERE id = '00000000-0000-0000-0000-00000000b104') IS DISTINCT FROM true
     OR (SELECT next_action_key FROM public.leads WHERE id = '00000000-0000-0000-0000-00000000b104') IS DISTINCT FROM 'reply_now'
  THEN RAISE EXCEPTION 'the human reply_now prompt was blanked — it must survive'; END IF;
  IF (SELECT eligible_at FROM public.leads WHERE id = '00000000-0000-0000-0000-00000000b104') IS NOT NULL
  THEN RAISE EXCEPTION 'eligible_at survived next to a prompt key — that is a send trigger'; END IF;
END $$;

-- 4. Returns the number of leads defused; an empty array is a no-op.
DO $$ BEGIN
  IF public.pause_leads_on_inbound(ARRAY[]::uuid[], 'noop', true) <> 0
  THEN RAISE EXCEPTION 'empty input should touch nothing'; END IF;
END $$;

SELECT 'inbound_pause_defuses_executor: all checks passed' AS result;
