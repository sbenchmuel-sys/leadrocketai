-- ═══════════════════════════════════════════════════════════════════
-- Unit G-B: the Outlook dedupe key must be LEAD-SCOPED.
--
-- `internetMessageId` is the RFC 2822 Message-ID and it is GLOBAL: one sender
-- emailing two DrivePilot customers produces two copies carrying the SAME
-- Message-ID. `interactions.dedupe_key` is globally unique, so the unscoped key
-- `outlook:<Message-ID>` made the second workspace's insert a duplicate of the
-- first's — and createCanonicalInteraction then resolved it to the FIRST
-- workspace's interaction row and projected that foreign id into the second
-- lead's timeline. A cross-tenant write.
--
-- This file proves it against the REAL unique index rather than by reasoning:
-- it shows the unscoped key being REJECTED across tenants, and the lead-scoped
-- key being accepted, using the same constraints production has.
-- ═══════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on

INSERT INTO public.workspaces (id, name) VALUES
  ('00000000-0000-0000-0000-00000000fff1', 'Dealership A'),
  ('00000000-0000-0000-0000-00000000fff2', 'Dealership B');

-- The same shopper, a lead in BOTH workspaces. (Production has 350 addresses
-- that are leads in more than one workspace.)
INSERT INTO public.leads (id, workspace_id, name, email) VALUES
  ('00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-00000000fff1', 'Shopper', 'shopper@example.com'),
  ('00000000-0000-0000-0000-00000000f102', '00000000-0000-0000-0000-00000000fff2', 'Shopper', 'shopper@example.com');

-- 1. THE BUG. One email, one Message-ID, delivered to both dealerships.
--    Under the UNSCOPED key the second insert violates the GLOBAL unique index.
DO $$ BEGIN
  INSERT INTO public.interactions (lead_id, type, dedupe_key)
  VALUES ('00000000-0000-0000-0000-00000000f101', 'email_inbound', 'outlook:<shared@example.com>');

  INSERT INTO public.interactions (lead_id, type, dedupe_key)
  VALUES ('00000000-0000-0000-0000-00000000f102', 'email_inbound', 'outlook:<shared@example.com>');

  RAISE EXCEPTION 'the unscoped key did NOT collide — this test can no longer detect the bug it exists for';
EXCEPTION WHEN unique_violation THEN
  -- Expected. In production this 23505 is swallowed by
  -- createCanonicalInteraction, which then resolves to the OTHER tenant's row.
  NULL;
END $$;

-- Leave only the first tenant's row behind for the next check.
DELETE FROM public.interactions WHERE dedupe_key = 'outlook:<shared@example.com>';

-- 2. THE FIX. The same email under LEAD-SCOPED keys: two rows, no collision,
--    each owned by its own tenant.
INSERT INTO public.interactions (lead_id, type, dedupe_key) VALUES
  ('00000000-0000-0000-0000-00000000f101', 'email_inbound', 'outlook:00000000-0000-0000-0000-00000000f101:<shared@example.com>'),
  ('00000000-0000-0000-0000-00000000f102', 'email_inbound', 'outlook:00000000-0000-0000-0000-00000000f102:<shared@example.com>');

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.interactions
   WHERE dedupe_key LIKE 'outlook:%<shared@example.com>';
  IF n <> 2 THEN RAISE EXCEPTION 'expected one interaction per tenant, got %', n; END IF;

  -- And each row belongs to the lead whose scope its key carries.
  IF EXISTS (
    SELECT 1 FROM public.interactions
     WHERE dedupe_key LIKE 'outlook:%<shared@example.com>'
       AND dedupe_key NOT LIKE 'outlook:' || lead_id::text || ':%'
  ) THEN RAISE EXCEPTION 'an interaction carries another lead''s scope'; END IF;
END $$;

-- 3. The unification still works: the webhook and the sync storing the SAME
--    message against the SAME lead must still collapse onto one row. That is
--    the whole reason the key was unified, and scoping must not undo it.
DO $$ BEGIN
  INSERT INTO public.interactions (lead_id, type, dedupe_key)
  VALUES ('00000000-0000-0000-0000-00000000f101', 'email_inbound', 'outlook:00000000-0000-0000-0000-00000000f101:<shared@example.com>');
  RAISE EXCEPTION 'a second write of the same message on the same lead should have collided';
EXCEPTION WHEN unique_violation THEN NULL; END $$;

-- 4. A rep emailing TWO leads at one company: one message, one workspace, two
--    legitimate direct conversations. Workspace scoping would still collide
--    here; lead scoping does not. This is why the scope is the lead.
INSERT INTO public.leads (id, workspace_id, name, email) VALUES
  ('00000000-0000-0000-0000-00000000f103', '00000000-0000-0000-0000-00000000fff1', 'Colleague', 'colleague@example.com');
INSERT INTO public.interactions (lead_id, type, dedupe_key) VALUES
  ('00000000-0000-0000-0000-00000000f101', 'email_outbound', 'outlook:00000000-0000-0000-0000-00000000f101:<broadcast@example.com>'),
  ('00000000-0000-0000-0000-00000000f103', 'email_outbound', 'outlook:00000000-0000-0000-0000-00000000f103:<broadcast@example.com>');

-- 5. The timeline is lead-scoped by its own constraint, so the same key on two
--    leads is fine there — and must stay fine.
INSERT INTO public.lead_timeline_items (workspace_id, lead_id, dedupe_key) VALUES
  ('00000000-0000-0000-0000-00000000fff1', '00000000-0000-0000-0000-00000000f101', 'outlook:00000000-0000-0000-0000-00000000f101:<shared@example.com>'),
  ('00000000-0000-0000-0000-00000000fff2', '00000000-0000-0000-0000-00000000f102', 'outlook:00000000-0000-0000-0000-00000000f102:<shared@example.com>');

-- ═══════════════════════════════════════════════════════════════════
-- 6. THE BACKFILL, running the real migration file.
--
-- `\i` the migration rather than copying its SQL, so this cannot drift from
-- what Lovable will actually apply. It is written to be re-runnable, so running
-- it here is safe even though the harness may also have applied it.
-- ═══════════════════════════════════════════════════════════════════

-- Legacy rows in exactly the shapes production holds today.
INSERT INTO public.leads (id, workspace_id, name, email) VALUES
  ('00000000-0000-0000-0000-00000000f201', '00000000-0000-0000-0000-00000000fff1', 'Legacy', 'legacy@example.com');
INSERT INTO public.interactions (id, lead_id, type, dedupe_key) VALUES
  ('00000000-0000-0000-0000-00000000e201', '00000000-0000-0000-0000-00000000f201', 'email_inbound', 'outlook:<legacy@example.com>');
INSERT INTO public.lead_timeline_items (id, workspace_id, lead_id, dedupe_key) VALUES
  ('00000000-0000-0000-0000-00000000e202', '00000000-0000-0000-0000-00000000fff1', '00000000-0000-0000-0000-00000000f201', 'outlook:<legacy@example.com>'),
  -- the un-namespaced graph-id fallback (production has exactly one of these)
  ('00000000-0000-0000-0000-00000000e203', '00000000-0000-0000-0000-00000000fff1', '00000000-0000-0000-0000-00000000f201', 'outlook:AAMkGRAPHID'),
  -- the UUID fallback, which the migration deliberately leaves alone
  ('00000000-0000-0000-0000-00000000e204', '00000000-0000-0000-0000-00000000fff1', '00000000-0000-0000-0000-00000000f201', 'outlook:interaction:00000000-0000-0000-0000-0000000000aa');

\i supabase/migrations/20260914120000_unify_outlook_dedupe_keys.sql

DO $$ BEGIN
  IF (SELECT dedupe_key FROM public.interactions WHERE id = '00000000-0000-0000-0000-00000000e201')
     <> 'outlook:00000000-0000-0000-0000-00000000f201:<legacy@example.com>'
  THEN RAISE EXCEPTION 'interaction key was not rewritten to the lead scope'; END IF;

  IF (SELECT dedupe_key FROM public.lead_timeline_items WHERE id = '00000000-0000-0000-0000-00000000e202')
     <> 'outlook:00000000-0000-0000-0000-00000000f201:<legacy@example.com>'
  THEN RAISE EXCEPTION 'timeline key was not rewritten to the lead scope'; END IF;

  -- The graph fallback must land on the helper's NAMESPACED shape. Prefixing
  -- the lead onto the raw graph id produces a key `outlookEmailDedupeKey` can
  -- never emit, so the next sync would not recognise the row and would import
  -- the message again. src/test/outlookDedupeKeyMigrationParity.test.ts pins
  -- this literal against the real helper's output.
  IF (SELECT dedupe_key FROM public.lead_timeline_items WHERE id = '00000000-0000-0000-0000-00000000e203')
     <> 'outlook:00000000-0000-0000-0000-00000000f201:graph:AAMkGRAPHID'
  THEN RAISE EXCEPTION 'graph-id fallback key was not rewritten to the namespaced shape'; END IF;

  IF (SELECT dedupe_key FROM public.lead_timeline_items WHERE id = '00000000-0000-0000-0000-00000000e204')
     <> 'outlook:interaction:00000000-0000-0000-0000-0000000000aa'
  THEN RAISE EXCEPTION 'the UUID fallback should have been left alone'; END IF;

  -- The already-scoped rows from the checks above must not have been rewritten
  -- a second time (the migration is re-runnable, not re-applying).
  IF EXISTS (
    SELECT 1 FROM public.interactions
     WHERE dedupe_key LIKE 'outlook:%'
       AND dedupe_key NOT LIKE 'outlook:interaction:%'
       AND dedupe_key NOT LIKE 'outlook:' || lead_id::text || ':%'
  ) THEN RAISE EXCEPTION 'an interaction still carries an unscoped Outlook key'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.lead_timeline_items
     WHERE dedupe_key LIKE 'outlook:%'
       AND dedupe_key NOT LIKE 'outlook:interaction:%'
       AND dedupe_key NOT LIKE 'outlook:' || lead_id::text || ':%'
  ) THEN RAISE EXCEPTION 'a timeline row still carries an unscoped Outlook key'; END IF;
END $$;

-- Running it twice must be a no-op, not a second rewrite.
\i supabase/migrations/20260914120000_unify_outlook_dedupe_keys.sql
DO $$ BEGIN
  IF (SELECT dedupe_key FROM public.interactions WHERE id = '00000000-0000-0000-0000-00000000e201')
     <> 'outlook:00000000-0000-0000-0000-00000000f201:<legacy@example.com>'
  THEN RAISE EXCEPTION 'the migration is not idempotent — a second run changed the key'; END IF;
END $$;

SELECT 'outlook_dedupe_key_scope: all checks passed' AS result;
