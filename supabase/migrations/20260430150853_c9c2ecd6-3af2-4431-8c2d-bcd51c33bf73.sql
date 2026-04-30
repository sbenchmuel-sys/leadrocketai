-- One-time cleanup of stale eligible_at on non-consented leads.
-- Audit per workspace before clearing.
DO $$
DECLARE
  v_total INT;
BEGIN
  SELECT COUNT(*) INTO v_total
  FROM public.leads
  WHERE automation_mode IS NULL
    AND eligible_at IS NOT NULL;

  INSERT INTO public.cron_run_log (job_name, request_id, status, status_code, metadata, completed_at, duration_ms)
  VALUES (
    'manual-ghost-automation-cleanup',
    gen_random_uuid()::text,
    'ok',
    200,
    jsonb_build_object(
      'rows_to_clean', v_total,
      'note', 'Leads with eligible_at but no automation_mode (ghost queue from syncEngine bug)'
    ),
    now(),
    0
  );
END $$;

UPDATE public.leads
SET eligible_at = NULL,
    needs_action = false,
    next_action_key = NULL,
    next_action_label = NULL,
    action_reason_code = NULL
WHERE automation_mode IS NULL
  AND eligible_at IS NOT NULL;