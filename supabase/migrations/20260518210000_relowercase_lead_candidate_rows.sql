-- 20260518210000_relowercase_lead_candidate_rows.sql
--
-- Defense-in-depth backfill following PR #28
-- (20260514120000_normalize_lead_candidate_constraints_via_trigger.sql).
--
-- That hotfix swapped the case-insensitive expression unique indexes from
-- 20260511010000 back to raw column unique constraints, with the
-- case-insensitive guarantee enforced via BEFORE INSERT/UPDATE triggers.
-- Existing rows were assumed to already be lowercase from the original
-- 20260511010000 normalization step.
--
-- The gap: between 20260511010000 and 20260514120000, the expression
-- unique index enforced uniqueness on lower(col) but did NOT lowercase
-- the stored value. A writer that bypassed the upstream normalizers
-- could have inserted `Example.com` and had it stored raw — the index
-- accepted it because no other row had lower(domain)='example.com'.
--
-- After PR #28 the trigger lowercases new writes, so a subsequent insert
-- of `example.com` is stored lowercase and clears the raw unique on
-- (workspace_id, domain) — the existing `Example.com` row would now
-- coexist with `example.com`, violating the case-insensitive invariant.
--
-- All in-tree writers (detect-lead-candidates, lookback-seed-candidates,
-- PendingLeadsTab.domainOf()) already normalize upstream, so the dirty
-- state is unlikely in practice. Worth landing for defense-in-depth, and
-- to keep the storage representation aligned with what the trigger now
-- enforces on every new write.
--
-- Failure mode: if any case-only duplicates somehow slipped through (two
-- rows that differ only in case in the same workspace), the UPDATE will
-- fail predictably on the raw unique constraint. That failure is the
-- desired signal — pause and dedupe manually before re-running.

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
