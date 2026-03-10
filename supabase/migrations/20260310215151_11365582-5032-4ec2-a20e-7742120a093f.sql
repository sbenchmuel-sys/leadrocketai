
-- Create lead_signals table
CREATE TABLE public.lead_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  signal_type text NOT NULL CHECK (signal_type IN ('hiring', 'funding', 'product_launch', 'new_partnership', 'job_change', 'expansion', 'event', 'press')),
  signal_description text NOT NULL,
  source_url text,
  detected_at timestamp with time zone NOT NULL DEFAULT now(),
  confidence_score double precision DEFAULT 0.5,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.lead_signals ENABLE ROW LEVEL SECURITY;

-- Users can view signals for their own leads
CREATE POLICY "Users can view signals for their leads"
  ON public.lead_signals FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.leads
    WHERE leads.id = lead_signals.lead_id
    AND (leads.owner_user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  ));

-- Users can insert signals for their own leads
CREATE POLICY "Users can insert signals for their leads"
  ON public.lead_signals FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.leads
    WHERE leads.id = lead_signals.lead_id
    AND (leads.owner_user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  ));

-- Users can delete signals for their own leads
CREATE POLICY "Users can delete signals for their leads"
  ON public.lead_signals FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.leads
    WHERE leads.id = lead_signals.lead_id
    AND (leads.owner_user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  ));

-- Service role full access
CREATE POLICY "Service role full access on lead_signals"
  ON public.lead_signals FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Index for fast lookups
CREATE INDEX idx_lead_signals_lead_id ON public.lead_signals(lead_id);
CREATE INDEX idx_lead_signals_type ON public.lead_signals(signal_type);
