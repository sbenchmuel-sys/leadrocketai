-- 20260514120000_normalize_lead_candidate_constraints_via_trigger.sql

DROP INDEX IF EXISTS public.idx_lead_candidates_unique_pending;
DROP INDEX IF EXISTS public.workspace_dismissed_domains_workspace_lower_domain_key;
DROP INDEX IF EXISTS public.workspace_dismissed_emails_workspace_lower_email_key;
DROP INDEX IF EXISTS public.workspace_internal_domains_workspace_lower_domain_key;

CREATE OR REPLACE FUNCTION public.lowercase_lead_candidate_contact_email()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
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
SET search_path TO 'public'
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
SET search_path TO 'public'
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
SET search_path TO 'public'
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
  'One PENDING candidate per (workspace, contact_email). Case-insensitive via the lead_candidates_lowercase_contact_email BEFORE INSERT/UPDATE trigger.';

COMMENT ON FUNCTION public.lowercase_lead_candidate_contact_email() IS
  'Normalizes contact_email to lowercase before insert/update so the raw unique partial index enforces case-insensitive uniqueness.';
COMMENT ON FUNCTION public.lowercase_workspace_dismissed_domain() IS
  'Normalizes domain to lowercase before insert/update.';
COMMENT ON FUNCTION public.lowercase_workspace_dismissed_email() IS
  'Normalizes email to lowercase before insert/update.';
COMMENT ON FUNCTION public.lowercase_workspace_internal_domain() IS
  'Normalizes domain to lowercase before insert/update.';