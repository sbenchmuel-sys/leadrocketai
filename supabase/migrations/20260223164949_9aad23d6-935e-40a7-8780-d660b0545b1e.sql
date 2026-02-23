
-- Apply column-level security to mail_accounts to hide OAuth tokens
-- Workspace members can view mail account metadata but NOT tokens
REVOKE SELECT ON public.mail_accounts FROM authenticated;

GRANT SELECT (
  id, workspace_id, provider, email_address, display_name,
  external_user_id, status, is_default, last_sync_at,
  token_expires_at, error_reason, created_at, updated_at
) ON public.mail_accounts TO authenticated;
