ALTER TABLE public.interactions
  ADD COLUMN IF NOT EXISTS to_emails TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS cc_emails TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.interactions.to_emails IS
  'All recipient addresses from the To header (lowercase, trimmed). Includes the primary to_email.';
COMMENT ON COLUMN public.interactions.cc_emails IS
  'All Cc recipients from the email Cc header (lowercase, trimmed).';