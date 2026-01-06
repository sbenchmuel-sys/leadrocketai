-- Add step_key column to drafts table for nurture sequence tracking
ALTER TABLE public.drafts 
ADD COLUMN step_key TEXT,
ADD COLUMN nurture_theme TEXT,
ADD COLUMN nurture_cadence TEXT;