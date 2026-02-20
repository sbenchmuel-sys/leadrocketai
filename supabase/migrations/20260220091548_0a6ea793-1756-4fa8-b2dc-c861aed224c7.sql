-- Add unique constraint on mail_account_id for outlook_subscriptions upsert
-- (one active subscription per account)
ALTER TABLE public.outlook_subscriptions
  DROP CONSTRAINT IF EXISTS outlook_subscriptions_mail_account_id_key;

ALTER TABLE public.outlook_subscriptions
  ADD CONSTRAINT outlook_subscriptions_mail_account_id_key UNIQUE (mail_account_id);

-- Add unique constraint on workspace_id + email_address for mail_accounts upsert
ALTER TABLE public.mail_accounts
  DROP CONSTRAINT IF EXISTS mail_accounts_workspace_id_email_address_key;

ALTER TABLE public.mail_accounts
  ADD CONSTRAINT mail_accounts_workspace_id_email_address_key UNIQUE (workspace_id, email_address);

-- Add paused as a valid status in automation_log (no enum — it's a text column, this is just documentation)
-- The actual pause is written as status='paused' with error_message='reply_received'