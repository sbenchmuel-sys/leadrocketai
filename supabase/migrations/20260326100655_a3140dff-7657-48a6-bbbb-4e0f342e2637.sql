-- Repair leads with eligible_at set but needs_action=false and no next_action_key
UPDATE leads SET eligible_at = NULL WHERE eligible_at IS NOT NULL AND needs_action = false AND next_action_key IS NULL;

-- Repair leads with needs_action=true but no eligible_at (orphaned state)
UPDATE leads SET eligible_at = now() + interval '5 minutes' WHERE needs_action = true AND eligible_at IS NULL AND next_action_key LIKE 'send_pre_%';