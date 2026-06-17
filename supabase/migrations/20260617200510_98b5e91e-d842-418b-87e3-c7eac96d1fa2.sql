-- Reclassify lookback-imported leads that were wrongly tagged as cold outbound
-- prospecting. Scope: leads created from approved lead_candidates with
-- source = 'lookback_seed', never enrolled in automation, with a real inbound
-- on file (i.e. truly warm), within the last 60 days.
UPDATE public.leads l
SET motion = 'inbound_response',
    stage = 'engaged',
    source_type = 'gmail_inbound'
FROM public.lead_candidates lc
WHERE lc.resolved_lead_id = l.id
  AND lc.source = 'lookback_seed'
  AND lc.status = 'approved'
  AND l.motion = 'outbound_prospecting'
  AND l.last_inbound_at IS NOT NULL
  AND l.automation_mode IS NULL
  AND l.eligible_at IS NULL
  AND l.created_at > now() - interval '60 days';