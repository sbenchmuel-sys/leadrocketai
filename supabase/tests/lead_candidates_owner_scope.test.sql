-- ═══════════════════════════════════════════════════════════════════
-- Checks for 20261103210000_lead_candidates_owner_scope.sql under real RLS:
-- the ownerless Outlook candidate is backfilled to the mailbox owner, a rep sees
-- and resolves only their own pending leads, and so does the admin (no see-all).
-- (Rows are inserted by the test after the migration ran, so the backfill is
-- re-run here on a fresh NULL row.)
-- ═══════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on

INSERT INTO public.workspaces (id, name) VALUES ('00000000-0000-0000-0000-0000000000e1', 'Paythings');
INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000e01', 'admin'),  -- Cliff
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000e02', 'rep');
INSERT INTO public.mail_accounts (id, workspace_id, provider, email_address, user_id, status) VALUES
  ('00000000-0000-0000-0000-000000000ea1', '00000000-0000-0000-0000-0000000000e1', 'outlook', 'cliff@pay.example',
   '00000000-0000-0000-0000-000000000e01', 'connected');
INSERT INTO public.lead_candidates (workspace_id, owner_user_id, contact_email) VALUES
  ('00000000-0000-0000-0000-0000000000e1', NULL,                                   'from-cliffs-outlook@x.example'),
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000e01', 'cliffs@x.example'),
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000e02', 'reps@x.example');

-- Backfill (same statement as the migration).
UPDATE public.lead_candidates c SET owner_user_id = o.user_id
  FROM (SELECT workspace_id, (array_agg(DISTINCT user_id))[1] AS user_id FROM public.mail_accounts
         WHERE provider = 'outlook' AND user_id IS NOT NULL GROUP BY workspace_id
        HAVING count(DISTINCT user_id) = 1) o
 WHERE c.owner_user_id IS NULL AND c.workspace_id = o.workspace_id;
DO $$ BEGIN
  IF (SELECT owner_user_id FROM public.lead_candidates WHERE contact_email = 'from-cliffs-outlook@x.example')
     IS DISTINCT FROM '00000000-0000-0000-0000-000000000e01' THEN
    RAISE EXCEPTION 'ownerless Outlook candidate was not backfilled to the mailbox owner';
  END IF;
END $$;

SET ROLE authenticated;

-- 1. The rep sees only their own pending lead.
SELECT set_config('test.uid', '00000000-0000-0000-0000-000000000e02', false);
DO $$ BEGIN
  IF (SELECT array_agg(contact_email ORDER BY contact_email) FROM public.lead_candidates) IS DISTINCT FROM ARRAY['reps@x.example'] THEN
    RAISE EXCEPTION 'rep sees %', (SELECT array_agg(contact_email) FROM public.lead_candidates);
  END IF;
END $$;
-- 2. …and cannot dismiss Cliff's (silently matches 0 rows under RLS).
UPDATE public.lead_candidates SET status = 'dismissed' WHERE contact_email = 'cliffs@x.example';
UPDATE public.lead_candidates SET status = 'dismissed' WHERE contact_email = 'reps@x.example';

-- 3. The admin sees only their own two — not the rep's.
SELECT set_config('test.uid', '00000000-0000-0000-0000-000000000e01', false);
DO $$ BEGIN
  IF (SELECT array_agg(contact_email ORDER BY contact_email) FROM public.lead_candidates)
     IS DISTINCT FROM ARRAY['cliffs@x.example','from-cliffs-outlook@x.example'] THEN
    RAISE EXCEPTION 'admin sees %', (SELECT array_agg(contact_email) FROM public.lead_candidates);
  END IF;
END $$;

RESET ROLE;
DO $$ BEGIN
  IF (SELECT status FROM public.lead_candidates WHERE contact_email = 'cliffs@x.example') <> 'pending' THEN
    RAISE EXCEPTION 'rep changed the admin''s candidate'; END IF;
  IF (SELECT status FROM public.lead_candidates WHERE contact_email = 'reps@x.example') <> 'dismissed' THEN
    RAISE EXCEPTION 'rep could not resolve their own candidate'; END IF;
END $$;
SELECT set_config('test.uid', '', false);
