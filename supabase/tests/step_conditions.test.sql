-- ═══════════════════════════════════════════════════════════════════
-- Checks for 20260907000100_cadence_step_conditions.sql: the condition column
-- + CHECK, the leads.linkedin_connected_at signal, and that the reconciling
-- step-replace RPC round-trips `condition` (and still drops it when absent).
-- ═══════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on

INSERT INTO public.workspaces (id, name) VALUES ('00000000-0000-0000-0000-00000000cccc', 'WS C');
INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('00000000-0000-0000-0000-00000000cccc', '00000000-0000-0000-0000-000000000301', 'member');
INSERT INTO public.campaigns (id, workspace_id, name, status) VALUES
  ('00000000-0000-0000-0000-0000000c0003', '00000000-0000-0000-0000-00000000cccc', 'Camp 3', 'draft');
INSERT INTO public.campaign_steps (campaign_id, step_number, channel, delay_days) VALUES
  ('00000000-0000-0000-0000-0000000c0003', 1, 'email', 0),
  ('00000000-0000-0000-0000-0000000c0003', 2, 'linkedin', 1);

-- 1. Only the three known conditions (or NULL) are storable.
DO $$ BEGIN
  UPDATE public.campaign_steps SET condition = 'moon_is_full'
   WHERE campaign_id = '00000000-0000-0000-0000-0000000c0003' AND step_number = 2;
  RAISE EXCEPTION 'expected an unknown condition to be refused';
EXCEPTION WHEN check_violation THEN NULL; END $$;
UPDATE public.campaign_steps SET condition = 'linkedin_accepted'
 WHERE campaign_id = '00000000-0000-0000-0000-0000000c0003' AND step_number = 2;

-- 2. The signal column exists on leads.
INSERT INTO public.leads (id, workspace_id, owner_user_id, name, email, linkedin_connected_at) VALUES
  ('00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000cccc', '00000000-0000-0000-0000-000000000301', 'Sig', 'sig@ok.example', now());

-- 3. replace_campaign_steps_reconciled carries `condition` through, and a step
--    without one lands NULL.
SET test.uid = '00000000-0000-0000-0000-000000000301';
SELECT public.replace_campaign_steps_reconciled('00000000-0000-0000-0000-0000000c0003', jsonb_build_array(
  jsonb_build_object('orig_step_number', 1, 'channel', 'email',    'delay_days', 0),
  jsonb_build_object('orig_step_number', 2, 'channel', 'linkedin', 'delay_days', 1, 'condition', 'linkedin_accepted'),
  jsonb_build_object('channel', 'voice', 'delay_days', 2, 'condition', 'no_call_answered'),
  jsonb_build_object('channel', 'email', 'delay_days', 2, 'condition', '')
));
DO $$ BEGIN
  IF (SELECT condition FROM public.campaign_steps WHERE campaign_id = '00000000-0000-0000-0000-0000000c0003' AND step_number = 2) <> 'linkedin_accepted' THEN RAISE EXCEPTION 'condition lost on surviving step'; END IF;
  IF (SELECT condition FROM public.campaign_steps WHERE campaign_id = '00000000-0000-0000-0000-0000000c0003' AND step_number = 3) <> 'no_call_answered' THEN RAISE EXCEPTION 'condition lost on inserted step'; END IF;
  IF (SELECT condition FROM public.campaign_steps WHERE campaign_id = '00000000-0000-0000-0000-0000000c0003' AND step_number = 4) IS NOT NULL THEN RAISE EXCEPTION 'empty condition should store NULL'; END IF;
  IF (SELECT condition FROM public.campaign_steps WHERE campaign_id = '00000000-0000-0000-0000-0000000c0003' AND step_number = 1) IS NOT NULL THEN RAISE EXCEPTION 'absent condition should store NULL'; END IF;
END $$;

SELECT 'step_conditions: all checks passed' AS result;
