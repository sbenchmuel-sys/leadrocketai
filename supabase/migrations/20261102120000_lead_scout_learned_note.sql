-- 20261102120000_lead_scout_learned_note.sql
--
-- Lead Scout Unit 4: the weekly learning step's one-line "What I learned".
--
-- scout-weekly-run writes it (service role) on the batch's scout_runs row after
-- the batch finishes; the Pending tab shows it under the batch header and hides
-- it when NULL. Members can already SELECT scout_runs (Unit 1 policy); no policy
-- or grant change. Nullable, no default: older batches simply have no note.
ALTER TABLE public.scout_runs
  ADD COLUMN IF NOT EXISTS learned_note TEXT;

COMMENT ON COLUMN public.scout_runs.learned_note IS
  'Lead Scout weekly batch: one plain sentence on what the learning step changed this week (NULL = nothing learned / not a weekly batch).';
