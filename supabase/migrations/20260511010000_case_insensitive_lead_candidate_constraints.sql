-- 20260511010000_case_insensitive_lead_candidate_constraints.sql
--
-- Rebuild the uniqueness constraints in the lead-candidate pipeline so that
-- email and domain values are compared case-insensitively. The original
-- constraints (from 20260429180000_lead_candidates_pipeline.sql) used raw
-- column values, which made `Alice@x.com` and `alice@x.com` two distinct
-- rows. That breaks the "one pending candidate per workspace+email"
-- guarantee, lets the same domain appear twice in a blocklist, and causes
-- filter misses unless every upstream writer perfectly lowercases inputs.
--
-- Flagged by Codex on PR #4.
--
-- Strategy: normalize any existing mixed-case rows in place, then swap the
-- raw-column uniqueness constraints for expression unique indexes on
-- `lower(<col>)`. The normalization is idempotent. If existing data already
-- contains case-only collisions (e.g. two rows that differ only in case),
-- the constraint creation step will fail predictably — the failure is the
-- desired signal that the data needs manual deduplication before the index
-- can be enforced.

-- ── 1. Normalize existing data ──────────────────────────────────────────────

UPDATE public.lead_candidates
   SET contact_email = lower(contact_email)
 WHERE contact_email <> lower(contact_email);

UPDATE public.workspace_dismissed_domains
   SET domain = lower(domain)
 WHERE domain <> lower(domain);

UPDATE public.workspace_dismissed_emails
   SET email = lower(email)
 WHERE email <> lower(email);

UPDATE public.workspace_internal_domains
   SET domain = lower(domain)
 WHERE domain <> lower(domain);

-- ── 2. lead_candidates: rebuild the partial pending-uniqueness index ────────
-- The original index keys on raw contact_email; replace with lower(contact_email).

DROP INDEX IF EXISTS public.idx_lead_candidates_unique_pending;

CREATE UNIQUE INDEX idx_lead_candidates_unique_pending
  ON public.lead_candidates (workspace_id, lower(contact_email))
  WHERE status = 'pending';

-- ── 3. workspace_dismissed_domains: swap UNIQUE constraint for expr index ───
-- Inline `UNIQUE (workspace_id, domain)` was auto-named *_workspace_id_domain_key.

ALTER TABLE public.workspace_dismissed_domains
  DROP CONSTRAINT IF EXISTS workspace_dismissed_domains_workspace_id_domain_key;

CREATE UNIQUE INDEX workspace_dismissed_domains_workspace_lower_domain_key
  ON public.workspace_dismissed_domains (workspace_id, lower(domain));

-- ── 4. workspace_dismissed_emails: same pattern ─────────────────────────────

ALTER TABLE public.workspace_dismissed_emails
  DROP CONSTRAINT IF EXISTS workspace_dismissed_emails_workspace_id_email_key;

CREATE UNIQUE INDEX workspace_dismissed_emails_workspace_lower_email_key
  ON public.workspace_dismissed_emails (workspace_id, lower(email));

-- ── 5. workspace_internal_domains: same pattern ─────────────────────────────

ALTER TABLE public.workspace_internal_domains
  DROP CONSTRAINT IF EXISTS workspace_internal_domains_workspace_id_domain_key;

CREATE UNIQUE INDEX workspace_internal_domains_workspace_lower_domain_key
  ON public.workspace_internal_domains (workspace_id, lower(domain));

COMMENT ON INDEX public.idx_lead_candidates_unique_pending IS
  'One PENDING candidate per (workspace, lower(contact_email)). Case-insensitive.';
COMMENT ON INDEX public.workspace_dismissed_domains_workspace_lower_domain_key IS
  'Workspace-scoped uniqueness, case-insensitive on domain.';
COMMENT ON INDEX public.workspace_dismissed_emails_workspace_lower_email_key IS
  'Workspace-scoped uniqueness, case-insensitive on email.';
COMMENT ON INDEX public.workspace_internal_domains_workspace_lower_domain_key IS
  'Workspace-scoped uniqueness, case-insensitive on domain.';
