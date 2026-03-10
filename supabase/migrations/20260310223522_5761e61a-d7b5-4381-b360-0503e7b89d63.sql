
-- Add signal_source column to lead_signals
ALTER TABLE public.lead_signals ADD COLUMN IF NOT EXISTS signal_source text NOT NULL DEFAULT 'manual';

-- Add source_detail for extra metadata (e.g. URL, message ID)
ALTER TABLE public.lead_signals ADD COLUMN IF NOT EXISTS source_detail jsonb NULL DEFAULT NULL;

-- Index for efficient lookups by lead + source
CREATE INDEX IF NOT EXISTS idx_lead_signals_lead_source ON public.lead_signals (lead_id, signal_source);

-- Trigger to invalidate lead_context_cache when signals change
CREATE OR REPLACE TRIGGER trg_invalidate_cache_on_lead_signal
  AFTER INSERT OR UPDATE OR DELETE ON public.lead_signals
  FOR EACH ROW
  EXECUTE FUNCTION public.invalidate_lead_context_cache();
