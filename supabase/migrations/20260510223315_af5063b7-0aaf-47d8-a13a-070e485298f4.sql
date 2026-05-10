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