-- Recovery: Fix 30 stuck nurture leads with needs_action=false
-- Set needs_action=true and ensure next_action_key is valid
UPDATE leads 
SET 
  needs_action = true,
  next_action_key = COALESCE(
    NULLIF(next_action_key, ''),
    'send_nurture_' || (COALESCE(nurture_outbound_count, 0) + 1)
  ),
  next_action_label = COALESCE(
    NULLIF(next_action_label, ''),
    'Nurture email #' || (COALESCE(nurture_outbound_count, 0) + 1)
  ),
  action_reason_code = 'NURTURE_DUE',
  -- Reschedule overdue leads to tomorrow 9:30 AM
  eligible_at = CASE 
    WHEN eligible_at < now() THEN (date_trunc('day', now()) + interval '1 day' + interval '9 hours 30 minutes')
    ELSE eligible_at
  END
WHERE motion = 'nurture' 
  AND nurture_status = 'active'
  AND status IN ('active', 'new')
  AND unsubscribed = false
  AND (needs_action = false OR next_action_key IS NULL)
  AND next_action_key IS DISTINCT FROM 'ooo_return_followup';