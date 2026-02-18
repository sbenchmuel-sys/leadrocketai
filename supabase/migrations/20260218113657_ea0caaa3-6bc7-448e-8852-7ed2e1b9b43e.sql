
-- ============================================================
-- Hybrid WhatsApp Automation: Schema additions
-- ============================================================

-- 1.1 Workspace Automation Settings
CREATE TABLE IF NOT EXISTS public.workspace_automation_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id uuid NOT NULL UNIQUE,
  default_mode text NOT NULL DEFAULT 'suggest_only'
    CHECK (default_mode IN ('manual', 'suggest_only', 'hybrid', 'full_auto')),
  confidence_threshold float NOT NULL DEFAULT 0.85,
  blocked_keywords jsonb NOT NULL DEFAULT '["discount","lawyer","contract","refund","cancel","compliance","lawsuit"]'::jsonb,
  blocked_stages jsonb NOT NULL DEFAULT '["negotiation","contract_sent"]'::jsonb,
  after_hours_auto boolean NOT NULL DEFAULT false,
  weekend_auto boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.workspace_automation_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace admins can manage automation settings"
  ON public.workspace_automation_settings
  FOR ALL
  USING (is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (is_workspace_admin(workspace_id, auth.uid()));

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.update_workspace_automation_settings_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_workspace_automation_settings_updated_at
  BEFORE UPDATE ON public.workspace_automation_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_workspace_automation_settings_updated_at();

-- 1.2 Leads table extensions
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS whatsapp_number text,
  ADD COLUMN IF NOT EXISTS automation_mode text CHECK (automation_mode IN ('manual', 'suggest_only', 'hybrid', 'full_auto')),
  ADD COLUMN IF NOT EXISTS auto_created boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS acceleration_until timestamp with time zone,
  ADD COLUMN IF NOT EXISTS engagement_score integer NOT NULL DEFAULT 0;

-- 1.3 Messages table extensions
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS is_automated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS intent text,
  ADD COLUMN IF NOT EXISTS ai_confidence float,
  ADD COLUMN IF NOT EXISTS whatsapp_message_id text;

-- 1.4 Automation Logs table
CREATE TABLE IF NOT EXISTS public.automation_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id uuid NOT NULL,
  lead_id uuid,
  message_id uuid,
  decision text NOT NULL,
  reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.automation_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view automation logs"
  ON public.automation_logs
  FOR SELECT
  USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Service role can insert automation logs"
  ON public.automation_logs
  FOR INSERT
  WITH CHECK (true);

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_automation_logs_workspace_id ON public.automation_logs (workspace_id);
CREATE INDEX IF NOT EXISTS idx_automation_logs_lead_id ON public.automation_logs (lead_id);
CREATE INDEX IF NOT EXISTS idx_leads_whatsapp_number ON public.leads (whatsapp_number);
CREATE INDEX IF NOT EXISTS idx_messages_whatsapp_message_id ON public.messages (whatsapp_message_id);
