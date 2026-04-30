UPDATE public.leads
SET next_action_key = 'send_pre_2',
    next_action_label = 'Step 2 of 3',
    needs_action = true,
    action_reason_code = 'FOLLOWUP_DUE'
WHERE id = '20355d9e-1c21-41cd-ac50-f7ceca996544'
  AND next_action_key = 'send_pre_1'
  AND last_outbound_at IS NOT NULL;