
-- Create automation_log table
CREATE TABLE public.automation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL,
  action_key text,
  ai_task text,
  status text NOT NULL DEFAULT 'pending',
  error_message text,
  gmail_message_id text,
  subject text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- Add unsubscribed column to leads
ALTER TABLE public.leads ADD COLUMN unsubscribed boolean NOT NULL DEFAULT false;

-- Enable RLS
ALTER TABLE public.automation_log ENABLE ROW LEVEL SECURITY;

-- Users can see logs for their own leads
CREATE POLICY "Users can view their own automation logs"
  ON public.automation_log FOR SELECT
  USING (owner_user_id = auth.uid());

-- Service role can insert (edge functions)
CREATE POLICY "Service role can insert automation logs"
  ON public.automation_log FOR INSERT
  WITH CHECK (true);

-- Index for querying by lead
CREATE INDEX idx_automation_log_lead_id ON public.automation_log(lead_id);
CREATE INDEX idx_automation_log_owner ON public.automation_log(owner_user_id);
