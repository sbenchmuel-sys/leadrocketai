-- Add buying_signals_json to lead_intelligence for normalized buying signals
ALTER TABLE public.lead_intelligence
  ADD COLUMN IF NOT EXISTS buying_signals_json jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Add index for recompute queue pattern (find stale intelligence)
CREATE INDEX IF NOT EXISTS idx_lead_intelligence_last_computed
  ON public.lead_intelligence (last_computed_at);
