
-- Add claimed_at and claim_expires_at to automation_log for stale-claim recovery
ALTER TABLE public.automation_log
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;

-- Drop the old unique index that used only claim_date
DROP INDEX IF EXISTS automation_log_claim_unique;

-- Create a new unique index on (lead_id, action_key, claim_date) for claiming/sent rows
-- This uses claim_date (calendar day) as the execution window key
CREATE UNIQUE INDEX IF NOT EXISTS automation_log_claim_unique
  ON public.automation_log (lead_id, action_key, claim_date)
  WHERE status IN ('claiming', 'sent');

-- Create an index to efficiently find stale claims for recovery
CREATE INDEX IF NOT EXISTS idx_automation_log_stale_claims
  ON public.automation_log (status, claim_expires_at)
  WHERE status = 'claiming';
