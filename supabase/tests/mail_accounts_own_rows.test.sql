-- ═══════════════════════════════════════════════════════════════════
-- Checks for 20261101100000_mail_accounts_own_rows.sql under real RLS:
-- a rep sees and updates only their OWN mailbox, an admin still sees all,
-- and nobody can reach another workspace's mailbox.
-- ═══════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on

INSERT INTO public.workspaces (id, name) VALUES
  ('00000000-0000-0000-0000-0000000000d1', 'Pilot'),
  ('00000000-0000-0000-0000-0000000000d2', 'Elsewhere');
INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000d01', 'admin'),  -- Cliff
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000d02', 'rep'),    -- the rep
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-000000000d02', 'rep');
INSERT INTO public.mail_accounts (id, workspace_id, provider, email_address, user_id, status) VALUES
  ('00000000-0000-0000-0000-000000000da1', '00000000-0000-0000-0000-0000000000d1', 'outlook', 'cliff@pilot.example', '00000000-0000-0000-0000-000000000d01', 'connected'),
  ('00000000-0000-0000-0000-000000000da2', '00000000-0000-0000-0000-0000000000d1', 'outlook', 'rep@pilot.example',   '00000000-0000-0000-0000-000000000d02', 'connected'),
  -- the rep's row in a workspace where they are NOT the owner-of-record any more is still theirs;
  -- a row owned by someone else in another workspace must stay invisible:
  ('00000000-0000-0000-0000-000000000da3', '00000000-0000-0000-0000-0000000000d2', 'outlook', 'other@else.example', '00000000-0000-0000-0000-000000000d99', 'connected');

SET ROLE authenticated;

-- 1. The rep sees exactly their own mailbox.
SELECT set_config('test.uid', '00000000-0000-0000-0000-000000000d02', false);
DO $$ BEGIN
  IF (SELECT array_agg(email_address ORDER BY email_address) FROM public.mail_accounts) IS DISTINCT FROM ARRAY['rep@pilot.example'] THEN
    RAISE EXCEPTION 'rep sees %', (SELECT array_agg(email_address) FROM public.mail_accounts);
  END IF;
END $$;

-- 2. The rep can flag their own row, and cannot touch Cliff's.
UPDATE public.mail_accounts SET needs_reconnect = true WHERE id = '00000000-0000-0000-0000-000000000da2';
UPDATE public.mail_accounts SET needs_reconnect = true WHERE id = '00000000-0000-0000-0000-000000000da1';
-- 3. And cannot hand their row to someone else.
DO $$ BEGIN
  UPDATE public.mail_accounts SET user_id = '00000000-0000-0000-0000-000000000d01' WHERE id = '00000000-0000-0000-0000-000000000da2';
  RAISE EXCEPTION 'expected re-assigning a mailbox to be refused';
EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END $$;

-- 4. The admin still sees every mailbox in their workspace (and nothing outside it).
SELECT set_config('test.uid', '00000000-0000-0000-0000-000000000d01', false);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.mail_accounts) <> 2 THEN
    RAISE EXCEPTION 'admin sees % mailboxes', (SELECT count(*) FROM public.mail_accounts);
  END IF;
END $$;

RESET ROLE;
DO $$ BEGIN
  IF NOT (SELECT needs_reconnect FROM public.mail_accounts WHERE id = '00000000-0000-0000-0000-000000000da2') THEN
    RAISE EXCEPTION 'rep could not flag their own mailbox'; END IF;
  IF (SELECT needs_reconnect FROM public.mail_accounts WHERE id = '00000000-0000-0000-0000-000000000da1') THEN
    RAISE EXCEPTION 'rep changed the admin''s mailbox'; END IF;
END $$;
SELECT set_config('test.uid', '', false);
