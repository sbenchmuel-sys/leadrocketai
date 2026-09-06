-- ═══════════════════════════════════════════════════════════════════
-- Behavioural checks for enroll_campaign_leads + launch_campaign_with_schedule
-- (supabase/migrations/20260907000000_transactional_enrollment_rpcs.sql).
-- Run via scripts/test-sql.sh. Each DO block RAISEs on a failed expectation,
-- which makes psql exit non-zero under ON_ERROR_STOP.
-- ═══════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on

-- ── Fixture ────────────────────────────────────────────────────────
INSERT INTO public.workspaces (id, name) VALUES
  ('00000000-0000-0000-0000-00000000aaaa', 'WS A'),
  ('00000000-0000-0000-0000-00000000bbbb', 'WS B');
-- rep1 = member of A (owner of most leads); admin1 = admin of A; rep2 = member of B.
INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
  ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-000000000101', 'member'),
  ('00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-000000000102', 'admin'),
  ('00000000-0000-0000-0000-00000000bbbb', '00000000-0000-0000-0000-000000000201', 'member');

INSERT INTO public.campaigns (id, workspace_id, name, status) VALUES
  ('00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000aaaa', 'Camp 1', 'draft'),
  ('00000000-0000-0000-0000-0000000c0002', '00000000-0000-0000-0000-00000000aaaa', 'Camp 2', 'active');
INSERT INTO public.campaign_steps (campaign_id, step_number, channel, delay_days, active) VALUES
  ('00000000-0000-0000-0000-0000000c0001', 1, 'email', 0, true),
  ('00000000-0000-0000-0000-0000000c0001', 2, 'linkedin', 1, true),
  ('00000000-0000-0000-0000-0000000c0001', 3, 'voice', 2, false), -- inactive: not in fingerprint
  ('00000000-0000-0000-0000-0000000c0001', 4, 'email', 2, true);

INSERT INTO public.campaign_suppression_list (workspace_id, kind, value) VALUES
  ('00000000-0000-0000-0000-00000000aaaa', 'domain', 'blocked.example');

-- Leads (all in WS A unless noted), owned by rep1 unless noted.
INSERT INTO public.leads (id, workspace_id, owner_user_id, name, email, unsubscribed, campaign_id) VALUES
  ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-000000000101', 'Good One',     'one@ok.example',      false, NULL),
  ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-000000000101', 'Good Two',     'two@ok.example',      false, NULL),
  ('00000000-0000-0000-0000-00000000d003', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-000000000101', 'Opted Out',    'three@ok.example',    true,  NULL),
  ('00000000-0000-0000-0000-00000000d004', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-000000000101', 'Suppressed',   'four@BLOCKED.example',false, NULL),
  ('00000000-0000-0000-0000-00000000d005', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-000000000101', 'Other Camp',   'five@ok.example',     false, '00000000-0000-0000-0000-0000000c0002'),
  ('00000000-0000-0000-0000-00000000d006', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-000000000102', 'Admins Lead',  'six@ok.example',      false, NULL),
  ('00000000-0000-0000-0000-00000000d007', '00000000-0000-0000-0000-00000000bbbb', '00000000-0000-0000-0000-000000000201', 'Cross WS',     'seven@ok.example',    false, NULL),
  ('00000000-0000-0000-0000-00000000d008', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-000000000101', 'Member Already','eight@ok.example',   false, '00000000-0000-0000-0000-0000000c0001');

-- A helper that builds one enrollment entry with a 3-touch schedule.
CREATE OR REPLACE FUNCTION test_entry(_lead uuid, _start timestamptz) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'lead_id', _lead, 'started_at', _start,
    'touches', jsonb_build_array(
      jsonb_build_object('step_number', 1, 'channel', 'email',    'eligible_at', _start,                    'max_age_at', NULL),
      jsonb_build_object('step_number', 2, 'channel', 'linkedin', 'eligible_at', _start + interval '1 day', 'max_age_at', _start + interval '2 day'),
      jsonb_build_object('step_number', 4, 'channel', 'email',    'eligible_at', _start + interval '3 day', 'max_age_at', NULL)
    ));
$$;

-- ── enroll_campaign_leads ──────────────────────────────────────────

-- 1. Not a member → refused.
SET test.uid = '00000000-0000-0000-0000-000000000201';
DO $$ BEGIN
  PERFORM public.enroll_campaign_leads('00000000-0000-0000-0000-0000000c0001', '1:email:0|2:linkedin:1|4:email:2',
    jsonb_build_array(test_entry('00000000-0000-0000-0000-00000000d001', now())));
  RAISE EXCEPTION 'expected non-member to be refused';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;

-- 2. Stale step fingerprint → refused, nothing written.
SET test.uid = '00000000-0000-0000-0000-000000000101';
DO $$ BEGIN
  PERFORM public.enroll_campaign_leads('00000000-0000-0000-0000-0000000c0001', '1:email:0|2:linkedin:1',
    jsonb_build_array(test_entry('00000000-0000-0000-0000-00000000d001', now())));
  RAISE EXCEPTION 'expected stale fingerprint to be refused';
EXCEPTION WHEN serialization_failure THEN NULL; END $$;
DO $$ BEGIN
  IF (SELECT count(*) FROM public.campaign_enrollment) <> 0 THEN RAISE EXCEPTION 'stale-fingerprint call wrote rows'; END IF;
  IF (SELECT campaign_id FROM public.leads WHERE id = '00000000-0000-0000-0000-00000000d001') IS NOT NULL THEN RAISE EXCEPTION 'stale-fingerprint call stamped a lead'; END IF;
END $$;

-- 3. The mixed batch: good ones enroll, every fail-closed case is SKIPPED (not aborted).
DO $$
DECLARE r jsonb;
BEGIN
  r := public.enroll_campaign_leads('00000000-0000-0000-0000-0000000c0001', '1:email:0|2:linkedin:1|4:email:2',
    jsonb_build_array(
      test_entry('00000000-0000-0000-0000-00000000d001', now()),
      test_entry('00000000-0000-0000-0000-00000000d002', now() + interval '1 day'),
      test_entry('00000000-0000-0000-0000-00000000d003', now()), -- unsubscribed
      test_entry('00000000-0000-0000-0000-00000000d004', now()), -- suppressed domain (case-insensitive)
      test_entry('00000000-0000-0000-0000-00000000d005', now()), -- in another campaign
      test_entry('00000000-0000-0000-0000-00000000d006', now()), -- owned by someone else (caller is not admin)
      test_entry('00000000-0000-0000-0000-00000000d007', now()), -- other workspace
      test_entry('00000000-0000-0000-0000-00000000d008', now())  -- already a member of THIS campaign, no schedule yet → enrolls
    ));
  IF (r->'enrolled') <> jsonb_build_array('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-00000000d008') THEN
    RAISE EXCEPTION 'unexpected enrolled set: %', r->'enrolled';
  END IF;
  IF jsonb_array_length(r->'skipped') <> 5 THEN
    RAISE EXCEPTION 'expected 5 skipped, got %', r->'skipped';
  END IF;
  IF (SELECT count(*) FROM public.campaign_enrollment WHERE campaign_id = '00000000-0000-0000-0000-0000000c0001') <> 3 THEN RAISE EXCEPTION 'expected 3 enrollments'; END IF;
  IF (SELECT count(*) FROM public.campaign_touch WHERE campaign_id = '00000000-0000-0000-0000-0000000c0001') <> 9 THEN RAISE EXCEPTION 'expected 9 touches (3 × 3)'; END IF;
  -- Stamped only the enrolled leads.
  IF (SELECT count(*) FROM public.leads WHERE campaign_id = '00000000-0000-0000-0000-0000000c0001') <> 3 THEN RAISE EXCEPTION 'campaign_id stamped on the wrong leads'; END IF;
  -- The skipped "other campaign" lead kept its campaign.
  IF (SELECT campaign_id FROM public.leads WHERE id = '00000000-0000-0000-0000-00000000d005') <> '00000000-0000-0000-0000-0000000c0002' THEN RAISE EXCEPTION 'stole a lead from another campaign'; END IF;
  -- Touch rows carry the planned times + max_age (null for email).
  IF (SELECT max_age_at FROM public.campaign_touch WHERE lead_id = '00000000-0000-0000-0000-00000000d001' AND step_number = 1) IS NOT NULL THEN RAISE EXCEPTION 'email touch should have null max_age_at'; END IF;
  IF (SELECT max_age_at FROM public.campaign_touch WHERE lead_id = '00000000-0000-0000-0000-00000000d001' AND step_number = 2) IS NULL THEN RAISE EXCEPTION 'manual touch lost its max_age_at'; END IF;
  IF (SELECT started_at FROM public.campaign_enrollment WHERE lead_id = '00000000-0000-0000-0000-00000000d002') <= now() THEN RAISE EXCEPTION 'staggered started_at not honoured'; END IF;
END $$;

-- 4. Re-running is idempotent: already-enrolled leads are skipped, nothing duplicated.
DO $$
DECLARE r jsonb;
BEGIN
  r := public.enroll_campaign_leads('00000000-0000-0000-0000-0000000c0001', '1:email:0|2:linkedin:1|4:email:2',
    jsonb_build_array(test_entry('00000000-0000-0000-0000-00000000d001', now())));
  IF jsonb_array_length(r->'enrolled') <> 0 OR jsonb_array_length(r->'skipped') <> 1 THEN RAISE EXCEPTION 'expected re-enroll to skip: %', r; END IF;
  IF (SELECT count(*) FROM public.campaign_touch WHERE lead_id = '00000000-0000-0000-0000-00000000d001') <> 3 THEN RAISE EXCEPTION 'duplicate touches'; END IF;
END $$;

-- 5. An admin CAN enroll a colleague's lead.
SET test.uid = '00000000-0000-0000-0000-000000000102';
DO $$
DECLARE r jsonb;
BEGIN
  -- l006 is owned by the admin; make a fresh lead owned by rep1 to prove the admin path.
  INSERT INTO public.leads (id, workspace_id, owner_user_id, name, email) VALUES
    ('00000000-0000-0000-0000-00000000d009', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-000000000101', 'Reps Lead', 'nine@ok.example');
  r := public.enroll_campaign_leads('00000000-0000-0000-0000-0000000c0001', '1:email:0|2:linkedin:1|4:email:2',
    jsonb_build_array(test_entry('00000000-0000-0000-0000-00000000d009', now())));
  IF jsonb_array_length(r->'enrolled') <> 1 THEN RAISE EXCEPTION 'admin could not enroll a colleague''s lead: %', r; END IF;
END $$;

-- 6. Atomicity: a bad touch row in the LAST entry rolls back the WHOLE call —
--    the first (valid) entry is not left enrolled.
SET test.uid = '00000000-0000-0000-0000-000000000101';
INSERT INTO public.leads (id, workspace_id, owner_user_id, name, email) VALUES
  ('00000000-0000-0000-0000-00000000d010', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-000000000101', 'Atomic A', 'ten@ok.example'),
  ('00000000-0000-0000-0000-00000000d011', '00000000-0000-0000-0000-00000000aaaa', '00000000-0000-0000-0000-000000000101', 'Atomic B', 'eleven@ok.example');
DO $$ BEGIN
  PERFORM public.enroll_campaign_leads('00000000-0000-0000-0000-0000000c0001', '1:email:0|2:linkedin:1|4:email:2',
    jsonb_build_array(
      test_entry('00000000-0000-0000-0000-00000000d010', now()),
      jsonb_build_object('lead_id', '00000000-0000-0000-0000-00000000d011', 'started_at', now(),
        'touches', jsonb_build_array(jsonb_build_object('step_number', 1, 'channel', 'carrier_pigeon', 'eligible_at', now())))
    ));
  RAISE EXCEPTION 'expected the bad channel to abort the call';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.campaign_enrollment WHERE lead_id IN ('00000000-0000-0000-0000-00000000d010', '00000000-0000-0000-0000-00000000d011')) THEN
    RAISE EXCEPTION 'partial enrollment survived a failed call';
  END IF;
  IF EXISTS (SELECT 1 FROM public.leads WHERE id = '00000000-0000-0000-0000-00000000d010' AND campaign_id IS NOT NULL) THEN
    RAISE EXCEPTION 'campaign_id stamp survived a failed call';
  END IF;
END $$;

-- ── launch_campaign_with_schedule ──────────────────────────────────

-- Simulate one enrollment having already started (won't be re-anchored).
UPDATE public.campaign_enrollment SET current_step_number = 1, status = 'active'
 WHERE lead_id = '00000000-0000-0000-0000-00000000d008';

CREATE OR REPLACE FUNCTION test_plan_entry(_enr uuid, _start timestamptz) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'enrollment_id', _enr, 'started_at', _start,
    'touches', jsonb_build_array(
      jsonb_build_object('step_number', 1, 'channel', 'email',    'eligible_at', _start,                    'max_age_at', NULL),
      jsonb_build_object('step_number', 2, 'channel', 'linkedin', 'eligible_at', _start + interval '1 day', 'max_age_at', _start + interval '2 day'),
      jsonb_build_object('step_number', 4, 'channel', 'email',    'eligible_at', _start + interval '3 day', 'max_age_at', NULL)
    ));
$$;

-- 7. Plan that misses a not-started enrollment → refused (people added mid-launch).
DO $$
DECLARE e1 uuid;
BEGIN
  SELECT id INTO e1 FROM public.campaign_enrollment WHERE lead_id = '00000000-0000-0000-0000-00000000d001';
  PERFORM public.launch_campaign_with_schedule('00000000-0000-0000-0000-0000000c0001',
    jsonb_build_array(test_plan_entry(e1, now() + interval '10 day')));
  RAISE EXCEPTION 'expected incomplete plan to be refused';
EXCEPTION WHEN serialization_failure THEN NULL; END $$;
DO $$ BEGIN
  IF (SELECT status FROM public.campaigns WHERE id = '00000000-0000-0000-0000-0000000c0001') <> 'draft' THEN RAISE EXCEPTION 'refused launch still flipped status'; END IF;
END $$;

-- 8. Full plan → touches re-dated, started_at set, status active — all together.
DO $$
DECLARE e1 uuid; e2 uuid; e9 uuid; r jsonb; t0 timestamptz := date_trunc('day', now()) + interval '30 day';
BEGIN
  SELECT id INTO e1 FROM public.campaign_enrollment WHERE lead_id = '00000000-0000-0000-0000-00000000d001';
  SELECT id INTO e2 FROM public.campaign_enrollment WHERE lead_id = '00000000-0000-0000-0000-00000000d002';
  SELECT id INTO e9 FROM public.campaign_enrollment WHERE lead_id = '00000000-0000-0000-0000-00000000d009';
  r := public.launch_campaign_with_schedule('00000000-0000-0000-0000-0000000c0001',
    jsonb_build_array(test_plan_entry(e1, t0), test_plan_entry(e2, t0 + interval '1 day'), test_plan_entry(e9, t0 + interval '2 day')));
  IF (r->>'reanchored')::int <> 3 THEN RAISE EXCEPTION 'expected 3 reanchored, got %', r; END IF;
  IF (SELECT status FROM public.campaigns WHERE id = '00000000-0000-0000-0000-0000000c0001') <> 'active' THEN RAISE EXCEPTION 'campaign not activated'; END IF;
  IF (SELECT started_at FROM public.campaign_enrollment WHERE id = e2) <> t0 + interval '1 day' THEN RAISE EXCEPTION 'started_at not re-anchored'; END IF;
  IF (SELECT eligible_at FROM public.campaign_touch WHERE enrollment_id = e1 AND step_number = 4) <> t0 + interval '3 day' THEN RAISE EXCEPTION 'touch not re-dated'; END IF;
  IF (SELECT count(*) FROM public.campaign_touch WHERE enrollment_id = e1) <> 3 THEN RAISE EXCEPTION 'upsert duplicated touches'; END IF;
  -- The already-started enrollment (l008) was left alone.
  IF (SELECT current_step_number FROM public.campaign_enrollment WHERE lead_id = '00000000-0000-0000-0000-00000000d008') <> 1 THEN RAISE EXCEPTION 'started enrollment was touched'; END IF;
END $$;

-- 9. Launching again (now active) → refused.
DO $$ BEGIN
  PERFORM public.launch_campaign_with_schedule('00000000-0000-0000-0000-0000000c0001', '[]'::jsonb);
  RAISE EXCEPTION 'expected second launch to be refused';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;

SELECT 'enrollment_rpcs: all checks passed' AS result;
