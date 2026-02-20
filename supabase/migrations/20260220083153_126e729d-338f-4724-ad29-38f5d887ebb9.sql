-- Add unique partial index on automation_log to prevent concurrent duplicate sends
-- This enforces at most one 'sent' record per (lead_id, action_key) per calendar day
-- at the database level, eliminating the race condition between concurrent executor runs.
CREATE UNIQUE INDEX IF NOT EXISTS automation_log_one_per_day_unique
ON public.automation_log (lead_id, action_key, date_trunc('day', created_at AT TIME ZONE 'UTC'))
WHERE status = 'sent';