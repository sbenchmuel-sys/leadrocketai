CREATE TABLE public.orchestration_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  workspace_id UUID NOT NULL,
  lead_id UUID,
  task_type TEXT NOT NULL,
  effective_stage TEXT,
  primary_objective TEXT,
  secondary_objective TEXT,
  objective_confidence TEXT,
  override_source TEXT,
  dominant_layer TEXT,
  objection_classes TEXT[] DEFAULT '{}',
  commercial_intent TEXT,
  cta_strategy TEXT,
  is_urgent BOOLEAN DEFAULT false,
  objective_alignment_score SMALLINT,
  cta_alignment_score SMALLINT,
  focus_score SMALLINT,
  commercial_relevance_score SMALLINT,
  violation_rules TEXT[] DEFAULT '{}',
  regeneration_triggered BOOLEAN DEFAULT false,
  offer_key TEXT
);

ALTER TABLE public.orchestration_log ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_orchestration_log_workspace ON public.orchestration_log (workspace_id, created_at DESC);
CREATE INDEX idx_orchestration_log_objective ON public.orchestration_log (primary_objective, created_at DESC);
CREATE INDEX idx_orchestration_log_violations ON public.orchestration_log USING gin (violation_rules);

-- Service role only - no user RLS policies (internal logging table)
