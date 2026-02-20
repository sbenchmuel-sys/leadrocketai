
-- ============================================
-- 1. Create mail_accounts table
-- ============================================

CREATE TABLE public.mail_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  email_address   text NOT NULL,
  display_name    text NOT NULL,
  external_user_id text NULL,
  status          text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'expired', 'error')),
  is_default      boolean NOT NULL DEFAULT false,
  created_at      timestamp with time zone NOT NULL DEFAULT now(),
  updated_at      timestamp with time zone NOT NULL DEFAULT now()
);

-- Only one default per workspace
CREATE UNIQUE INDEX mail_accounts_workspace_default_idx
  ON public.mail_accounts (workspace_id)
  WHERE is_default = true;

-- Trigger for updated_at
CREATE TRIGGER mail_accounts_updated_at
  BEFORE UPDATE ON public.mail_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================
-- 2. RLS for mail_accounts
-- ============================================

ALTER TABLE public.mail_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members can view mail accounts"
  ON public.mail_accounts FOR SELECT
  USING (is_workspace_member(workspace_id, auth.uid()));

CREATE POLICY "Workspace admins can manage mail accounts"
  ON public.mail_accounts FOR ALL
  USING (is_workspace_admin(workspace_id, auth.uid()))
  WITH CHECK (is_workspace_admin(workspace_id, auth.uid()));

-- ============================================
-- 3. Add mail_account_id to automation_log
-- ============================================

ALTER TABLE public.automation_log
  ADD COLUMN IF NOT EXISTS mail_account_id uuid NULL
    REFERENCES public.mail_accounts(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.automation_log.mail_account_id IS
  'Which mail account was used. NULL = fallback to workspace default Gmail.';
