ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS action_resurfaced_at timestamptz;

COMMENT ON COLUMN public.leads.action_resurfaced_at IS
  'Stamped by syncEngine.buildLeadUpdate() when a fresh inbound clears action_dismissed_at and/or action_permanently_dismissed. Lets the queue UI surface "this lead just came back" without forcing the user to re-derive it. NULL = never resurfaced (or resurfaced before this column existed).';