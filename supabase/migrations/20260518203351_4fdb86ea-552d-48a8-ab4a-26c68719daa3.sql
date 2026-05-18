UPDATE public.lead_candidates
   SET contact_email = lower(contact_email)
 WHERE contact_email IS NOT NULL
   AND contact_email <> lower(contact_email);

UPDATE public.workspace_dismissed_domains
   SET domain = lower(domain)
 WHERE domain IS NOT NULL
   AND domain <> lower(domain);

UPDATE public.workspace_dismissed_emails
   SET email = lower(email)
 WHERE email IS NOT NULL
   AND email <> lower(email);

UPDATE public.workspace_internal_domains
   SET domain = lower(domain)
 WHERE domain IS NOT NULL
   AND domain <> lower(domain);