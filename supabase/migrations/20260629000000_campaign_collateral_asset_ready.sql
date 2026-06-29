-- ═══════════════════════════════════════════════════════════════════
-- Outbound/Inbound PR 3 — uploaded-collateral "Use in emails" confirm.
--
-- Adds a single boolean to the EXISTING campaign_collateral table. An uploaded
-- brief (asset_path/asset_url, PR 4.1) is INERT until a rep ticks "Use in this
-- campaign's emails" (asset_ready). PR 4 (sender) offers the one-pager link ONLY
-- when asset_ready = true, so a half-uploaded or wrong file can never reach a
-- prospect.
--
-- Additive + idempotent. Default false = no existing brief is auto-emailable.
-- No RLS change — the existing member RLS on campaign_collateral covers this.
-- Applying this migration cannot change a single outgoing email.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.campaign_collateral
  ADD COLUMN IF NOT EXISTS asset_ready boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.campaign_collateral.asset_ready IS
  'The rep''s "Use in emails" confirm on an uploaded brief. PR 4 offers the brief''s public link in a follow-up email ONLY when asset_ready = true. Defaults false so an uploaded-but-unconfirmed brief is never sent.';
