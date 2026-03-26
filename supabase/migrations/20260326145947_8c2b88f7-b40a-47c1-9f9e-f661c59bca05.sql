-- Backfill dedupe_key for email interactions
UPDATE public.interactions
SET dedupe_key = CASE
  WHEN source = 'gmail' AND gmail_message_id IS NOT NULL THEN 'gmail:' || gmail_message_id
  WHEN source = 'outlook' AND gmail_message_id IS NOT NULL THEN 'outlook:' || gmail_message_id
  ELSE NULL
END
WHERE dedupe_key IS NULL AND gmail_message_id IS NOT NULL;

-- Deduplicate: keep earliest row per dedupe_key
DELETE FROM public.interactions a
USING public.interactions b
WHERE a.dedupe_key IS NOT NULL
  AND a.dedupe_key = b.dedupe_key
  AND a.id > b.id;

-- Create unique partial index on dedupe_key
CREATE UNIQUE INDEX IF NOT EXISTS idx_interactions_dedupe_key_unique
  ON public.interactions (dedupe_key)
  WHERE dedupe_key IS NOT NULL;