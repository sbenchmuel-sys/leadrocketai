
-- Add storage_path column to call_recordings for direct path-based signing
ALTER TABLE public.call_recordings ADD COLUMN IF NOT EXISTS storage_path text;

-- Backfill existing rows: extract path from storage_url
UPDATE public.call_recordings
SET storage_path = regexp_replace(storage_url, '^.*/call-recordings/', '')
WHERE storage_url IS NOT NULL AND storage_path IS NULL;
