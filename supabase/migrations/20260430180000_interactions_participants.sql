-- 20260430180000_interactions_participants.sql
--
-- Phase 1 of the multi-contact thread support (Reply-all).
--
-- Adds full participant arrays alongside the legacy single-recipient columns.
-- `to_email` / `from_email` remain the canonical primary recipient/sender; the
-- new arrays capture every address present on the email's To / Cc headers so
-- the UI can render the full participant set and the reply composer can offer
-- reply-all defaults.
--
-- Default '{}' (empty array) is harmless for non-email interaction rows
-- (system_note, whatsapp_*, etc.) — they simply ignore the columns.

ALTER TABLE public.interactions
  ADD COLUMN IF NOT EXISTS to_emails TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS cc_emails TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.interactions.to_emails IS
  'All recipient addresses from the To header (lowercase, trimmed). Includes the primary to_email.';
COMMENT ON COLUMN public.interactions.cc_emails IS
  'All Cc recipients from the email Cc header (lowercase, trimmed).';
