-- EMERGENCY HALT: stop all queued automated sends for Cliff's workspace.
-- These were scheduled by syncEngine without explicit user consent.
UPDATE public.leads
SET needs_action = false,
    eligible_at = NULL,
    next_action_key = NULL,
    next_action_label = NULL,
    action_reason_code = NULL
WHERE workspace_id = '9c92f7ce-38f1-49ad-baba-1a7833d6a34b'
  AND needs_action = true
  AND eligible_at IS NOT NULL
  AND automation_mode IS NULL;