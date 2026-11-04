-- ═══════════════════════════════════════════════════════════════════
-- Checks for 20261104220000_timeline_items_user_insert.sql under real RLS,
-- using the same upsert insertInteraction() sends (ON CONFLICT lead_id,dedupe_key).
-- ═══════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on

INSERT INTO public.workspaces (id, name) VALUES
  ('00000000-0000-0000-0000-0000000000f1', 'Pilot'),
  ('00000000-0000-0000-0000-0000000000f2', 'Elsewhere');
INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000f01', 'admin'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000f02', 'rep'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000f03', 'rep'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-000000000f02', 'rep');
INSERT INTO public.leads (id, workspace_id, owner_user_id, name) VALUES
  ('00000000-0000-0000-0000-000000000fa1', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000f02', 'Rep lead');

SET ROLE authenticated;

-- 1. The owner can log a call note (the bug: this was refused).
SELECT set_config('test.uid', '00000000-0000-0000-0000-000000000f02', false);
INSERT INTO public.lead_timeline_items (workspace_id, lead_id, event_type, provider, dedupe_key)
  VALUES ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000fa1', 'call', 'manual', 'interaction:a')
  ON CONFLICT (lead_id, dedupe_key) DO UPDATE SET event_type = EXCLUDED.event_type;

-- 2. The owner cannot file it under another workspace they also belong to.
DO $$ BEGIN
  INSERT INTO public.lead_timeline_items (workspace_id, lead_id, event_type, dedupe_key)
    VALUES ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-000000000fa1', 'note', 'interaction:b');
  RAISE EXCEPTION 'expected wrong-workspace insert to be refused';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;

-- 3. Another rep in the same workspace cannot add to a lead they don't own.
SELECT set_config('test.uid', '00000000-0000-0000-0000-000000000f03', false);
DO $$ BEGIN
  INSERT INTO public.lead_timeline_items (workspace_id, lead_id, event_type, dedupe_key)
    VALUES ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000fa1', 'note', 'interaction:c');
  RAISE EXCEPTION 'expected non-owner rep insert to be refused';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;

-- 4. The workspace admin can add to any lead in their workspace.
SELECT set_config('test.uid', '00000000-0000-0000-0000-000000000f01', false);
INSERT INTO public.lead_timeline_items (workspace_id, lead_id, event_type, dedupe_key)
  VALUES ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000fa1', 'meeting', 'interaction:d');

RESET ROLE;
DO $$ BEGIN
  IF (SELECT array_agg(dedupe_key ORDER BY dedupe_key) FROM public.lead_timeline_items
      WHERE lead_id = '00000000-0000-0000-0000-000000000fa1') IS DISTINCT FROM ARRAY['interaction:a','interaction:d'] THEN
    RAISE EXCEPTION 'unexpected rows: %', (SELECT array_agg(dedupe_key) FROM public.lead_timeline_items
      WHERE lead_id = '00000000-0000-0000-0000-000000000fa1');
  END IF;
END $$;
SELECT set_config('test.uid', '', false);
