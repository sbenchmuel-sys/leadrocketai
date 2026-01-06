-- Add additional metadata columns to leads table for CSV import
ALTER TABLE public.leads 
ADD COLUMN IF NOT EXISTS job_title text,
ADD COLUMN IF NOT EXISTS phone text,
ADD COLUMN IF NOT EXISTS industry text,
ADD COLUMN IF NOT EXISTS country text,
ADD COLUMN IF NOT EXISTS initial_message text;