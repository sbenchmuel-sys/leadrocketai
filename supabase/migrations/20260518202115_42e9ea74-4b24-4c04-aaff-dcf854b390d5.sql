ALTER TABLE public.mail_accounts
  ADD COLUMN IF NOT EXISTS tenant_id TEXT;

COMMENT ON COLUMN public.mail_accounts.tenant_id IS
  'Microsoft Entra tenant ID (`tid` claim from the access-token JWT). Consumer/personal tenant is 9188040d-6c67-4c5b-b112-36a304b66dad. Null for Gmail or for Outlook accounts predating this column.';