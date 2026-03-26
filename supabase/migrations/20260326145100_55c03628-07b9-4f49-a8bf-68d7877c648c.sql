
-- Durable execution log for cron-dispatcher and scheduled jobs
CREATE TABLE public.cron_run_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name TEXT NOT NULL,
  dispatcher_target TEXT,
  request_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  status_code INTEGER,
  error_message TEXT,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Index for querying recent runs and failures
CREATE INDEX idx_cron_run_log_job_started ON public.cron_run_log (job_name, started_at DESC);
CREATE INDEX idx_cron_run_log_status ON public.cron_run_log (status) WHERE status != 'ok';

-- RLS: service-role only (no user access needed)
ALTER TABLE public.cron_run_log ENABLE ROW LEVEL SECURITY;

-- Auto-cleanup: delete logs older than 30 days (called by message-cleanup or dedicated cron)
-- No user-facing policy needed; only service-role writes/reads this table.
