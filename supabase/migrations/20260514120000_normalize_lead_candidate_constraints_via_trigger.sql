-- 20260514120000_normalize_lead_candidate_constraints_via_trigger.sql
--
-- Hotfix for the regression introduced by
-- 20260511010000_case_insensitive_lead_candidate_constraints.sql.
--
-- That migration replaced four raw `UNIQUE (workspace_id, <col>)`
-- constraints with expression unique indexes on `(workspace_id, lower(<col>))`.
-- PostgREST resolves the upsert `on_conflict` query parameter by column
-- list, NOT by expression — so any client call using the original raw
-- column list as the conflict target fails after that migration with a
-- "no matching constraint" error.
--
-- Concrete breakage: src/components/leads/PendingLeadsTab.tsx ships the
-- "Always reject domain" bulk action with
--   .upsert(rows, { onConflict: "workspace_id,domain", ignoreDuplicates: true })
-- on `workspace_dismissed_domains`. After 20260511010000 that path is
-- dead — no `workspace_id,domain` constraint exists, only the expression
-- index `(workspace_id, lower(domain))`. Flagged by Codex on PR #21
-- (https://github.com/sbenchmuel-sys/leadrocketai/pull/21#discussion_r3215656424).
--
-- Fix strategy: restore the raw column unique constraints so existing
-- PostgREST clients keep working, and enforce the case-insensitive
-- guarantee via a BEFORE INSERT/UPDATE trigger that lowercases the
-- relevant column. Trigger normalization + raw unique = same guarantee
-- as expression unique, but with a PostgREST-addressable conflict target.
--
-- Why apply order is safe:
--   - The previous migration already lowercased every existing row.
--   - All in-tree writers (detect-lead-candidates, lookback-seed-candidates,
--     PendingLeadsTab) already lowercase upstream; the trigger is a
--     defense-in-depth net for future writers, not a behavior change.
--   - Plus-aliasing stripping for lead_candidates.contact_email continues
--     to happen upstream — the trigger ONLY lowercases.

-- ── 1. Drop the expression unique indexes from 20260511010000 ──────────────

DROP INDEX IF EXISTS public.idx_lead_candidates_unique_pending;
DROP INDEX IF EXISTS public.workspace_dismissed_domains_workspace_lower_domain_key;
DROP INDEX IF EXISTS public.workspace_dismissed_emails_workspace_lower_email_key;
DROP INDEX IF EXISTS public.workspace_internal_domains_workspace_lower_domain_key;

-- ── 2. Normalization triggers — one per table ──────────────────────────────

CREATE OR REPLACE FUNCTION public.lowercase_lead_candidate_contact_email()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.contact_email IS NOT NULL THEN
    NEW.contact_email := lower(NEW.contact_email);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lead_candidates_lowercase_contact_email
  ON public.lead_candidates;
CREATE TRIGGER lead_candidates_lowercase_contact_email
  BEFORE INSERT OR UPDATE OF contact_email ON public.lead_candidates
  FOR EACH ROW EXECUTE FUNCTION public.lowercase_lead_candidate_contact_email();

CREATE OR REPLACE FUNCTION public.lowercase_workspace_dismissed_domain()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.domain IS NOT NULL THEN
    NEW.domain := lower(NEW.domain);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_dismissed_domains_lowercase_domain
  ON public.workspace_dismissed_domains;
CREATE TRIGGER workspace_dismissed_domains_lowercase_domain
  BEFORE INSERT OR UPDATE OF domain ON public.workspace_dismissed_domains
  FOR EACH ROW EXECUTE FUNCTION public.lowercase_workspace_dismissed_domain();

CREATE OR REPLACE FUNCTION public.lowercase_workspace_dismissed_email()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.email IS NOT NULL THEN
    NEW.email := lower(NEW.email);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_dismissed_emails_lowercase_email
  ON public.workspace_dismissed_emails;
CREATE TRIGGER workspace_dismissed_emails_lowercase_email
  BEFORE INSERT OR UPDATE OF email ON public.workspace_dismissed_emails
  FOR EACH ROW EXECUTE FUNCTION public.lowercase_workspace_dismissed_email();

CREATE OR REPLACE FUNCTION public.lowercase_workspace_internal_domain()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.domain IS NOT NULL THEN
    NEW.domain := lower(NEW.domain);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_internal_domains_lowercase_domain
  ON public.workspace_internal_domains;
CREATE TRIGGER workspace_internal_domains_lowercase_domain
  BEFORE INSERT OR UPDATE OF domain ON public.workspace_internal_domains
  FOR EACH ROW EXECUTE FUNCTION public.lowercase_workspace_internal_domain();

-- ── 3. Restore raw-column uniqueness constraints / indexes ────────────────
-- Constraint names match the auto-generated names from the original
-- 20260429180000_lead_candidates_pipeline.sql so anything that referenced
-- them by name (none in-tree today, but possible in DB tooling) keeps
-- resolving. Wrapped in DO blocks because ALTER TABLE ADD CONSTRAINT
-- lacks IF NOT EXISTS in current Postgres.

-- lead_candidates: partial unique index on raw column, same name as
-- 20260429180000 used.
CREATE UNIQUE INDEX idx_lead_candidates_unique_pending
  ON public.lead_candidates (workspace_id, contact_email)
  WHERE status = 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_dismissed_domains_workspace_id_domain_key'
  ) THEN
    ALTER TABLE public.workspace_dismissed_domains
      ADD CONSTRAINT workspace_dismissed_domains_workspace_id_domain_key
      UNIQUE (workspace_id, domain);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_dismissed_emails_workspace_id_email_key'
  ) THEN
    ALTER TABLE public.workspace_dismissed_emails
      ADD CONSTRAINT workspace_dismissed_emails_workspace_id_email_key
      UNIQUE (workspace_id, email);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_internal_domains_workspace_id_domain_key'
  ) THEN
    ALTER TABLE public.workspace_internal_domains
      ADD CONSTRAINT workspace_internal_domains_workspace_id_domain_key
      UNIQUE (workspace_id, domain);
  END IF;
END $$;

COMMENT ON INDEX public.idx_lead_candidates_unique_pending IS
  'One PENDING candidate per (workspace, contact_email). Case-insensitive '
  'via the lead_candidates_lowercase_contact_email BEFORE INSERT/UPDATE trigger.';

COMMENT ON FUNCTION public.lowercase_lead_candidate_contact_email() IS
  'Normalizes contact_email to lowercase before insert/update so the raw '
  'unique partial index enforces case-insensitive uniqueness.';
COMMENT ON FUNCTION public.lowercase_workspace_dismissed_domain() IS
  'Normalizes domain to lowercase before insert/update.';
COMMENT ON FUNCTION public.lowercase_workspace_dismissed_email() IS
  'Normalizes email to lowercase before insert/update.';
COMMENT ON FUNCTION public.lowercase_workspace_internal_domain() IS
  'Normalizes domain to lowercase before insert/update.';
