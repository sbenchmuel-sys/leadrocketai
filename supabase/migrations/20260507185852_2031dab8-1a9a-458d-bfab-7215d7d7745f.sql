UPDATE public.leads
SET automation_mode = NULL,
    eligible_at = NULL
WHERE workspace_id = 'a8e1d905-297c-42f2-83cf-681f0cbf4ce5'
  AND (automation_mode IS NOT NULL OR eligible_at IS NOT NULL);