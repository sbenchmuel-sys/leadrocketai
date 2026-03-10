
-- Create message_generation_log table for diversity control
CREATE TABLE public.message_generation_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  campaign_id UUID NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  task_type TEXT NOT NULL,
  generated_message TEXT NOT NULL,
  opening_type TEXT NOT NULL DEFAULT 'observation',
  primary_angle TEXT NOT NULL DEFAULT 'general',
  secondary_angle TEXT NULL,
  cta_type TEXT NOT NULL DEFAULT 'quick_question',
  tone TEXT NOT NULL DEFAULT 'professional',
  message_embedding extensions.vector(1536) NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Indexes for diversity lookups
CREATE INDEX idx_msg_gen_log_lead_id ON public.message_generation_log(lead_id, created_at DESC);
CREATE INDEX idx_msg_gen_log_workspace ON public.message_generation_log(workspace_id, created_at DESC);
CREATE INDEX idx_msg_gen_log_workspace_campaign ON public.message_generation_log(workspace_id, campaign_id, created_at DESC);

-- Enable RLS
ALTER TABLE public.message_generation_log ENABLE ROW LEVEL SECURITY;

-- Service role full access (edge functions write here)
CREATE POLICY "Service role full access on message_generation_log"
  ON public.message_generation_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated users can view their workspace's log
CREATE POLICY "Workspace members can view message_generation_log"
  ON public.message_generation_log
  FOR SELECT
  TO authenticated
  USING (is_workspace_member(workspace_id, auth.uid()));
