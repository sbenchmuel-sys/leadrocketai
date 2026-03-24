
-- ============================================================
-- Phase 4: Canonical lead_intelligence table
-- ============================================================

CREATE TABLE public.lead_intelligence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id),
  
  -- Core intelligence
  summary_text text,
  recommended_next_step text,
  next_step_reason text,
  
  -- Structured analysis
  milestones_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  risks_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  objections_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  engagement_signals_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  channel_recommendations_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  deal_factors_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  
  -- Metadata
  last_computed_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  model_used text,
  source_counts_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  
  CONSTRAINT uq_lead_intelligence_lead UNIQUE (lead_id)
);

-- Indexes
CREATE INDEX idx_lead_intelligence_workspace ON public.lead_intelligence(workspace_id);
CREATE INDEX idx_lead_intelligence_computed ON public.lead_intelligence(last_computed_at);

-- RLS
ALTER TABLE public.lead_intelligence ENABLE ROW LEVEL SECURITY;

-- Service role full access (for recompute function)
CREATE POLICY "Service role full access on lead_intelligence"
  ON public.lead_intelligence FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Workspace members can read
CREATE POLICY "Workspace members can view lead_intelligence"
  ON public.lead_intelligence FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));

-- Lead owners can trigger recompute (update)
CREATE POLICY "Lead owners can update lead_intelligence"
  ON public.lead_intelligence FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM leads WHERE leads.id = lead_intelligence.lead_id AND leads.owner_user_id = auth.uid()
  ));

-- Auto-update updated_at
CREATE TRIGGER trg_lead_intelligence_updated_at
  BEFORE UPDATE ON public.lead_intelligence
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
