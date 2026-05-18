-- ============================================================
-- mail_accounts.tenant_id
--
-- Stores the Microsoft Entra tenant identifier (the `tid` claim
-- from the access-token JWT) for Outlook accounts. Lets us detect
-- consumer/personal-tenant accounts (`9188040d-6c67-4c5b-b112-36a304b66dad`),
-- which can never carry work/school-only delegated permissions
-- such as `OnlineMeetingTranscript.Read.All`.
--
-- Without this, the calendar-reconsent hook nudges every Outlook
-- account whose granted_scopes lacks the transcript scope —
-- personal-tenant users have no way to grant it, so the prompt
-- loops forever.
--
-- Null for Gmail accounts and for Outlook accounts connected
-- before this column existed; outlook-callback writes it on every
-- new connect, and getFreshOutlookToken backfills it on the next
-- token refresh.
-- ============================================================

ALTER TABLE public.mail_accounts
  ADD COLUMN IF NOT EXISTS tenant_id TEXT;

COMMENT ON COLUMN public.mail_accounts.tenant_id IS
  'Microsoft Entra tenant ID (`tid` claim from the access-token JWT). Consumer/personal tenant is 9188040d-6c67-4c5b-b112-36a304b66dad. Null for Gmail or for Outlook accounts predating this column.';
