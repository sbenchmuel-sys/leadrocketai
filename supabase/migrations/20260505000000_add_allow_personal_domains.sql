-- 20260505000000_add_allow_personal_domains.sql
--
-- Adds a per-workspace toggle to allow personal email domains
-- (gmail.com, yahoo.com, outlook.com, etc.) to surface as lead candidates.
--
-- Default FALSE = current behaviour (personal domains are filtered out).
-- Set TRUE for workspaces that prospect into markets where people use
-- personal email for business (e.g. SE Asia, India, early-stage startups).

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS allow_personal_domains BOOLEAN NOT NULL DEFAULT FALSE;
