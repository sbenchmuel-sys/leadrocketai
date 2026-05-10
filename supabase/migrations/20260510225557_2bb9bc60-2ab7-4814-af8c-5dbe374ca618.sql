UPDATE public.lead_candidates SET contact_email = lower(contact_email) WHERE contact_email <> lower(contact_email);
UPDATE public.workspace_dismissed_domains SET domain = lower(domain) WHERE domain <> lower(domain);
UPDATE public.workspace_dismissed_emails SET email = lower(email) WHERE email <> lower(email);
UPDATE public.workspace_internal_domains SET domain = lower(domain) WHERE domain <> lower(domain);

DROP INDEX IF EXISTS public.idx_lead_candidates_unique_pending;
CREATE UNIQUE INDEX idx_lead_candidates_unique_pending
  ON public.lead_candidates (workspace_id, lower(contact_email))
  WHERE status = 'pending';

ALTER TABLE public.workspace_dismissed_domains
  DROP CONSTRAINT IF EXISTS workspace_dismissed_domains_workspace_id_domain_key;
CREATE UNIQUE INDEX workspace_dismissed_domains_workspace_lower_domain_key
  ON public.workspace_dismissed_domains (workspace_id, lower(domain));

ALTER TABLE public.workspace_dismissed_emails
  DROP CONSTRAINT IF EXISTS workspace_dismissed_emails_workspace_id_email_key;
CREATE UNIQUE INDEX workspace_dismissed_emails_workspace_lower_email_key
  ON public.workspace_dismissed_emails (workspace_id, lower(email));

ALTER TABLE public.workspace_internal_domains
  DROP CONSTRAINT IF EXISTS workspace_internal_domains_workspace_id_domain_key;
CREATE UNIQUE INDEX workspace_internal_domains_workspace_lower_domain_key
  ON public.workspace_internal_domains (workspace_id, lower(domain));

COMMENT ON INDEX public.idx_lead_candidates_unique_pending IS 'One PENDING candidate per (workspace, lower(contact_email)). Case-insensitive.';
COMMENT ON INDEX public.workspace_dismissed_domains_workspace_lower_domain_key IS 'Workspace-scoped uniqueness, case-insensitive on domain.';
COMMENT ON INDEX public.workspace_dismissed_emails_workspace_lower_email_key IS 'Workspace-scoped uniqueness, case-insensitive on email.';
COMMENT ON INDEX public.workspace_internal_domains_workspace_lower_domain_key IS 'Workspace-scoped uniqueness, case-insensitive on domain.';