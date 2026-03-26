-- Step 1: Add dedupe_key column
ALTER TABLE public.interactions ADD COLUMN IF NOT EXISTS dedupe_key TEXT;