
-- Entity enrichment cache table
CREATE TABLE public.entity_enrichment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  company text NOT NULL,
  query text NOT NULL,
  provider text NOT NULL DEFAULT 'google_cse',
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days')
);

-- Composite index for cache lookups
CREATE INDEX idx_enrichment_workspace_lead_expires
  ON public.entity_enrichment (workspace_id, lead_id, expires_at);

-- Enable RLS
ALTER TABLE public.entity_enrichment ENABLE ROW LEVEL SECURITY;

-- Workspace members can view enrichment data
CREATE POLICY "Workspace members can view enrichment"
  ON public.entity_enrichment FOR SELECT
  USING (is_workspace_member(workspace_id, auth.uid()));

-- Workspace members can create enrichment requests
CREATE POLICY "Workspace members can insert enrichment"
  ON public.entity_enrichment FOR INSERT
  WITH CHECK (is_workspace_member(workspace_id, auth.uid()));

-- Service role full access for edge function inserts
CREATE POLICY "Service role full access on entity_enrichment"
  ON public.entity_enrichment FOR ALL
  USING (true)
  WITH CHECK (true);
