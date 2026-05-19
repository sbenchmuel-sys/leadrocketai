BEGIN;

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