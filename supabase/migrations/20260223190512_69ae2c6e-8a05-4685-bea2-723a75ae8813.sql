CREATE INDEX idx_leads_executor_pickup
ON public.leads (owner_user_id, eligible_at)
WHERE needs_action = true AND eligible_at IS NOT NULL AND unsubscribed = false;