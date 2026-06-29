ALTER TABLE public.campaign_collateral
  ADD COLUMN IF NOT EXISTS asset_ready boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.campaign_collateral.asset_ready IS
  'The rep''s "Use in emails" confirm on an uploaded brief. PR 4 offers the brief''s public link in a follow-up email ONLY when asset_ready = true. Defaults false so an uploaded-but-unconfirmed brief is never sent.';