-- One-off remediation: clear the false unsubscribe on Ryan Frankel.
-- Root cause: inbound unsubscribe detection matched our OWN pitch line
-- ("…so you stop emailing…") quoted back in his reply. Fixed in code by
-- stripQuotedReply() in supabase/functions/_shared/unsubscribeDetection.ts.
--
-- This script ONLY undoes the bad write; the code fix prevents recurrence.
-- Run in the Supabase SQL editor (or ask Lovable to run it). NOT a migration —
-- it is a data fix, not schema, so it must not live in supabase/migrations/.
--
-- Scope is tight: the specific lead email + the exact auto-generated note text.
-- Wrapped in a transaction; review the SELECT counts before COMMIT.

BEGIN;

-- Sanity: which lead(s) are we touching?
SELECT id, workspace_id, email, unsubscribed, nurture_status
FROM leads
WHERE lower(email) = lower('rfrankel@researchoninvestment.com')
  AND unsubscribed = true;

-- 1) Re-arm the lead. unsubscribed -> false; nurture back to active.
--    Action fields (needs_action / eligible_at / next_action_*) are left for
--    recompute-lead-intelligence / the next sync to re-derive.
UPDATE leads
SET unsubscribed = false,
    nurture_status = 'active'
WHERE lower(email) = lower('rfrankel@researchoninvestment.com')
  AND unsubscribed = true;

-- 2) Remove the spurious system note from the canonical ledger.
DELETE FROM interactions i
USING leads l
WHERE i.lead_id = l.id
  AND lower(l.email) = lower('rfrankel@researchoninvestment.com')
  AND i.type = 'system_note'
  AND i.body_text = 'Lead requested to unsubscribe — automation stopped permanently.';

-- 3) Remove its timeline projection.
DELETE FROM lead_timeline_items t
USING leads l
WHERE t.lead_id = l.id
  AND lower(l.email) = lower('rfrankel@researchoninvestment.com')
  AND t.event_type = 'system_note'
  AND t.snippet_text = 'Lead requested to unsubscribe — automation stopped permanently.';

-- Verify, then COMMIT (or ROLLBACK if anything looks off).
SELECT id, email, unsubscribed, nurture_status
FROM leads
WHERE lower(email) = lower('rfrankel@researchoninvestment.com');

COMMIT;
