CREATE TABLE public.lead_ai_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  correction_type text NOT NULL DEFAULT 'content',
  correction_text text NOT NULL,
  original_draft text,
  corrected_draft text,
  ai_reasoning text,
  context_json jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_lead_ai_corrections_lead_id ON public.lead_ai_corrections(lead_id);
CREATE INDEX idx_lead_ai_corrections_user_lead ON public.lead_ai_corrections(user_id, lead_id);

ALTER TABLE public.lead_ai_corrections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can create corrections for their leads"
  ON public.lead_ai_corrections FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM leads WHERE leads.id = lead_ai_corrections.lead_id AND leads.owner_user_id = auth.uid()
    )
  );

CREATE POLICY "Users can view corrections for their leads"
  ON public.lead_ai_corrections FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM leads WHERE leads.id = lead_ai_corrections.lead_id AND leads.owner_user_id = auth.uid()
    )
  );

CREATE POLICY "Service role full access on lead_ai_corrections"
  ON public.lead_ai_corrections FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);