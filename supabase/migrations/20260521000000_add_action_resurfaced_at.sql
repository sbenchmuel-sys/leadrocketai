-- ============================================================
-- leads.action_resurfaced_at — re-arm audit timestamp
--
-- Today (`_shared/syncEngine.ts` buildLeadUpdate, lines 673-678) the
-- sync engine silently clears `action_dismissed_at` and
-- `action_permanently_dismissed` when a fresh inbound arrives after
-- a dismissal. No audit-log row, no stamp, no UI badge — reps see
-- leads they dismissed reappear with no explanation
-- (EDGE_CASES.md §9, KNOWN_ISSUES.md "No 'this lead was resurfaced'
-- audit signal").
--
-- This migration adds a nullable timestamp the sync engine stamps in
-- the SAME UPDATE that clears the dismissal columns. The Queue UI
-- (PR D) will read this to render a "↻ Resurfaced 2h ago" pill on
-- rows where `action_resurfaced_at > now() - <window>`.
--
-- Nullable + no default + no backfill: rows that were resurfaced
-- before this migration shipped don't get a synthetic timestamp.
-- That's the right call — we don't know when they were resurfaced.
--
-- No index: the column is only read alongside `needs_action=true`
-- queue rows, which are already filtered by the existing
-- (needs_action, eligible_at) indexes.
-- ============================================================

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS action_resurfaced_at timestamptz;

COMMENT ON COLUMN public.leads.action_resurfaced_at IS
  'Stamped by syncEngine.buildLeadUpdate() when a fresh inbound clears action_dismissed_at and/or action_permanently_dismissed. Lets the queue UI surface "this lead just came back" without forcing the user to re-derive it. NULL = never resurfaced (or resurfaced before this column existed).';
