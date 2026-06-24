-- ═══════════════════════════════════════════════
-- Per-step "Include meeting link" (cadence touch editor)
-- Additive only. Lets a rep pick PRECISELY which email touches carry the
-- meeting-booking link, instead of the single campaign-level
-- campaigns.include_meeting_cta toggle (which stays as the default).
--
-- NULL  = inherit the campaign-level default (today's behavior, unchanged for
--         every existing step — this is why the column is nullable, not
--         NOT NULL DEFAULT false).
-- TRUE  = force a meeting link on this email.
-- FALSE = force NO meeting link on this email, even if the campaign default is on.
--
-- Why a new column and not the existing campaign_steps.cta_type: cta_type is a
-- single primary-CTA value per step (question / soft_offer / breakup_close / …)
-- that the campaign resolver emits VERBATIM. "Include a meeting link" is
-- ORTHOGONAL — a follow-up email keeps its question CTA AND can carry a booking
-- link — so overloading cta_type would clobber the step's primary CTA. The
-- generation step (a later unit) reads campaign_steps.include_meeting_cta as the
-- per-step source of truth, falling back to campaigns.include_meeting_cta when NULL.
--
-- No RLS change: the existing "Members can manage campaign steps" policy
-- (workspace-scoped via the campaigns FK) already covers this column.
-- ═══════════════════════════════════════════════

ALTER TABLE public.campaign_steps
  ADD COLUMN IF NOT EXISTS include_meeting_cta BOOLEAN;

COMMENT ON COLUMN public.campaign_steps.include_meeting_cta IS
  'Per-step meeting-link override. NULL = inherit campaigns.include_meeting_cta (default); TRUE/FALSE = force on/off for this touch. Read at generation time as the per-step source of truth.';
