ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS website text,
  ADD COLUMN IF NOT EXISTS linkedin_url text,
  ADD COLUMN IF NOT EXISTS company_linkedin_url text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS state text;