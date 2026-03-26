-- Pre-send claim: add a claim_date column for uniqueness enforcement
ALTER TABLE public.automation_log ADD COLUMN IF NOT EXISTS claim_date date;

-- Backfill existing rows
UPDATE public.automation_log SET claim_date = (created_at AT TIME ZONE 'UTC')::date WHERE claim_date IS NULL;

-- Unique index: only one claiming/sent per lead+action_key per day
CREATE UNIQUE INDEX IF NOT EXISTS automation_log_claim_unique
  ON public.automation_log (lead_id, action_key, claim_date)
  WHERE status IN ('claiming', 'sent');