-- ============================================================
-- mail_event_log: idempotency log for mail webhooks
-- Prevents duplicate processing of the same provider message
-- ============================================================
CREATE TABLE IF NOT EXISTS public.mail_event_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  mail_account_id UUID REFERENCES public.mail_accounts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL DEFAULT 'received',
  payload JSONB,
  processed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_message_id)
);

-- Index for fast idempotency lookups
CREATE INDEX IF NOT EXISTS idx_mail_event_log_provider_msg
  ON public.mail_event_log (provider, provider_message_id);

-- Index for account-level queries
CREATE INDEX IF NOT EXISTS idx_mail_event_log_account
  ON public.mail_event_log (mail_account_id);

ALTER TABLE public.mail_event_log ENABLE ROW LEVEL SECURITY;

-- Service role can insert (webhooks use service key)
CREATE POLICY "Service role can insert mail event logs"
  ON public.mail_event_log
  FOR INSERT
  WITH CHECK (true);

-- Workspace members can view logs for their accounts
CREATE POLICY "Workspace members can view mail event logs"
  ON public.mail_event_log
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.mail_accounts ma
      JOIN public.workspace_members wm ON wm.workspace_id = ma.workspace_id
      WHERE ma.id = mail_event_log.mail_account_id
        AND wm.user_id = auth.uid()
    )
  );

-- ============================================================
-- outlook_subscriptions: track Graph webhook subscriptions
-- ============================================================
CREATE TABLE IF NOT EXISTS public.outlook_subscriptions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  mail_account_id UUID NOT NULL REFERENCES public.mail_accounts(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL UNIQUE,
  resource TEXT NOT NULL DEFAULT 'me/messages',
  change_types TEXT[] NOT NULL DEFAULT ARRAY['created'],
  expiration_at TIMESTAMP WITH TIME ZONE NOT NULL,
  notification_url TEXT,
  client_state TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_renewed_at TIMESTAMP WITH TIME ZONE,
  error_reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outlook_subscriptions_account
  ON public.outlook_subscriptions (mail_account_id);

CREATE INDEX IF NOT EXISTS idx_outlook_subscriptions_expiry
  ON public.outlook_subscriptions (expiration_at);

ALTER TABLE public.outlook_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage outlook subscriptions"
  ON public.outlook_subscriptions
  FOR ALL
  WITH CHECK (true);

CREATE POLICY "Workspace members can view outlook subscriptions"
  ON public.outlook_subscriptions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.mail_accounts ma
      JOIN public.workspace_members wm ON wm.workspace_id = ma.workspace_id
      WHERE ma.id = outlook_subscriptions.mail_account_id
        AND wm.user_id = auth.uid()
    )
  );

-- ============================================================
-- Add token fields to mail_accounts for Outlook OAuth tokens
-- ============================================================
ALTER TABLE public.mail_accounts
  ADD COLUMN IF NOT EXISTS access_token TEXT,
  ADD COLUMN IF NOT EXISTS refresh_token TEXT,
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS error_reason TEXT;