
-- Create lead_context_cache table
CREATE TABLE public.lead_context_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_generated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Unique constraint: one cache entry per lead
CREATE UNIQUE INDEX idx_lead_context_cache_lead_id ON public.lead_context_cache(lead_id);

-- Index for workspace lookups
CREATE INDEX idx_lead_context_cache_workspace_id ON public.lead_context_cache(workspace_id);

-- Enable RLS
ALTER TABLE public.lead_context_cache ENABLE ROW LEVEL SECURITY;

-- Service role full access (edge functions use this)
CREATE POLICY "Service role full access on lead_context_cache"
  ON public.lead_context_cache
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Users can view cache for their own leads
CREATE POLICY "Users can view context cache for their leads"
  ON public.lead_context_cache
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.leads
      WHERE leads.id = lead_context_cache.lead_id
      AND leads.owner_user_id = auth.uid()
    )
  );

-- Function to invalidate cache (called by triggers)
CREATE OR REPLACE FUNCTION public.invalidate_lead_context_cache()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
BEGIN
  -- Delete the cached context so it gets rebuilt on next AI call
  DELETE FROM public.lead_context_cache WHERE lead_id = COALESCE(NEW.lead_id, OLD.lead_id, NEW.id, OLD.id);
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Trigger: invalidate when a new signal is added
CREATE TRIGGER trg_invalidate_cache_on_signal
  AFTER INSERT ON public.lead_signals
  FOR EACH ROW
  EXECUTE FUNCTION public.invalidate_lead_context_cache();

-- Trigger: invalidate when a meeting summary is added/updated
CREATE TRIGGER trg_invalidate_cache_on_meeting_summary
  AFTER INSERT OR UPDATE ON public.meeting_summaries
  FOR EACH ROW
  EXECUTE FUNCTION public.invalidate_lead_context_cache();

-- Trigger: invalidate when enrichment data is added
CREATE TRIGGER trg_invalidate_cache_on_enrichment
  AFTER INSERT ON public.entity_enrichment
  FOR EACH ROW
  EXECUTE FUNCTION public.invalidate_lead_context_cache();
