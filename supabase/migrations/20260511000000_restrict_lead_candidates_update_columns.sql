-- 20260511000000_restrict_lead_candidates_update_columns.sql
--
-- Hardens the review-queue UPDATE path so workspace members cannot rewrite
-- candidate provenance or cross-workspace-reassign rows from the browser.
--
-- Background:
--   The original RLS policy on public.lead_candidates ("Workspace members can
--   update lead candidate status", added in 20260429180000_lead_candidates_pipeline.sql)
--   only enforces workspace membership. RLS policies in PostgreSQL operate at the
--   row level — they cannot restrict which columns an UPDATE may target. Combined
--   with the default Supabase grant of table-level UPDATE to the `authenticated`
--   role, that meant any signed-in workspace member could PATCH ai_score,
--   contact_email, source, owner_user_id, or even workspace_id (reassigning the
--   row to another workspace they belong to) via the PostgREST endpoint.
--
--   The legitimate client write path (src/components/leads/PendingLeadsTab.tsx)
--   only ever sets status / resolved_at / resolved_lead_id. All other column
--   mutations come from edge functions running as service_role (detect-lead-
--   candidates, score-lead-candidate, lookback-seed-candidates) and are
--   unaffected by these grants.
--
-- Fix:
--   Revoke broad UPDATE from `authenticated`, then re-grant UPDATE only on the
--   three columns the approve/dismiss flow needs. The existing row-level policy
--   continues to gate which rows are reachable.

REVOKE UPDATE ON public.lead_candidates FROM authenticated;

GRANT UPDATE (status, resolved_at, resolved_lead_id)
  ON public.lead_candidates
  TO authenticated;

COMMENT ON POLICY "Workspace members can update lead candidate status"
  ON public.lead_candidates IS
  'Row-level gate: members of the candidate''s workspace may UPDATE. '
  'Column-level gate (see GRANTs in 20260511000000): only status / resolved_at / '
  'resolved_lead_id are writable by authenticated; all other columns are '
  'service-role-only.';
