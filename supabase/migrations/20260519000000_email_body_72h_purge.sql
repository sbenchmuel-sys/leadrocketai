-- Extend the 72-hour raw-body purge to cover email.
--
-- Background: the public commitment "raw message bodies auto-purge after
-- 72 hours" was only enforced on public.messages (WhatsApp/SMS). Email
-- sync (gmail-sync, outlook-sync) writes raw bodies to public.interactions
-- (body_text) and public.lead_timeline_items (snippet_text); neither
-- table carried expires_at, so email bodies were retained indefinitely.
--
-- This migration adds expires_at to both tables, backfills it from
-- occurred_at so historical rows past 72h are purged on the next
-- message-cleanup run, and relaxes interactions.body_text to nullable
-- so the cleanup can null it the same way messages.body_ciphertext
-- already does.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. interactions: nullable body_text + expires_at + index
-- ---------------------------------------------------------------------------

ALTER TABLE public.interactions
  ALTER COLUMN body_text DROP NOT NULL;

ALTER TABLE public.interactions
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

UPDATE public.interactions
SET expires_at = occurred_at + interval '72 hours'
WHERE expires_at IS NULL;

ALTER TABLE public.interactions
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '72 hours'),
  ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_interactions_expires
  ON public.interactions(expires_at)
  WHERE body_text IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. lead_timeline_items: expires_at + index (snippet_text is already nullable)
-- ---------------------------------------------------------------------------

ALTER TABLE public.lead_timeline_items
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

UPDATE public.lead_timeline_items
SET expires_at = occurred_at + interval '72 hours'
WHERE expires_at IS NULL;

ALTER TABLE public.lead_timeline_items
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '72 hours'),
  ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lead_timeline_items_expires
  ON public.lead_timeline_items(expires_at)
  WHERE snippet_text IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Database-level fallback: extend expire_old_messages() so the SQL cron
--    (scheduled in 20260223154653_*.sql) also covers the email body columns
--    even if the message-cleanup edge function is down.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.expire_old_messages()
RETURNS void AS $$
BEGIN
  UPDATE public.messages
  SET body_ciphertext = NULL
  WHERE expires_at < NOW()
    AND body_ciphertext IS NOT NULL;

  UPDATE public.interactions
  SET body_text = NULL
  WHERE expires_at < NOW()
    AND body_text IS NOT NULL;

  UPDATE public.lead_timeline_items
  SET snippet_text = NULL
  WHERE expires_at < NOW()
    AND snippet_text IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public';

COMMIT;
