UPDATE public.leads
SET needs_action = false,
    eligible_at = NULL,
    next_action_key = NULL,
    next_action_label = NULL,
    action_reason_code = NULL,
    action_dismissed_at = now()
WHERE needs_action = true AND eligible_at IS NOT NULL;