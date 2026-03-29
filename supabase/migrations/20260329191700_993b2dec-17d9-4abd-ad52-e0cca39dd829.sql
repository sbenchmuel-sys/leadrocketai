CREATE TABLE public.deal_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL UNIQUE,
  workspace_id UUID NOT NULL,
  handled_objections TEXT[] DEFAULT '{}',
  unresolved_objections TEXT[] DEFAULT '{}',
  shared_assets TEXT[] DEFAULT '{}',
  sent_offers TEXT[] DEFAULT '{}',
  recent_cta_patterns TEXT[] DEFAULT '{}',
  unanswered_questions TEXT[] DEFAULT '{}',
  pending_buyin_needs TEXT[] DEFAULT '{}',
  logistics_constraints TEXT[] DEFAULT '{}',
  pricing_status TEXT DEFAULT 'not_discussed',
  momentum_state TEXT DEFAULT 'unknown',
  momentum_signals JSONB DEFAULT '{}',
  continuity_risks TEXT[] DEFAULT '{}',
  last_outbound_cta TEXT,
  ignored_cta_count SMALLINT DEFAULT 0,
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.deal_memory ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_deal_memory_workspace ON public.deal_memory (workspace_id);
CREATE INDEX idx_deal_memory_lead ON public.deal_memory (lead_id);
CREATE INDEX idx_deal_memory_momentum ON public.deal_memory (momentum_state);

-- Service role only for writes; workspace members can read
CREATE POLICY "Service role full access on deal_memory"
  ON public.deal_memory FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "Workspace members can view deal_memory"
  ON public.deal_memory FOR SELECT TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));
