WITH latest_inbound AS (
  SELECT DISTINCT ON (i.lead_id)
    i.lead_id,
    LOWER(COALESCE(i.body_text, '')) AS body
  FROM public.interactions i
  WHERE i.direction = 'inbound'
  ORDER BY i.lead_id, i.occurred_at DESC
),
lost AS (
  SELECT lead_id FROM latest_inbound
  WHERE body LIKE '%no opportunity%'
     OR body LIKE '%not an opportunity%'
     OR body LIKE '%doesn''t look like we have an opportunity%'
     OR body LIKE '%does not look like we have an opportunity%'
     OR body LIKE '%went with another%'
     OR body LIKE '%went with someone else%'
     OR body LIKE '%chose another%'
     OR body LIKE '%decided to go with another%'
     OR body LIKE '%not interested%'
     OR body LIKE '%no longer interested%'
     OR body LIKE '%not a fit%'
     OR body LIKE '%not the right fit%'
     OR body LIKE '%we''ll pass%'
     OR body LIKE '%we will pass%'
     OR body LIKE '%keep in touch for potential future%'
     OR body LIKE '%future opportunities%'
     OR body LIKE '%already have a solution%'
     OR body LIKE '%already have a vendor%'
     OR body LIKE '%closed with someone else%'
     OR body LIKE '%signed with another%'
)
UPDATE public.leads l
SET stage = 'engaged'
FROM lost
WHERE l.id = lost.lead_id
  AND l.stage = 'closing';

UPDATE public.leads
SET stage = 'engaged'
WHERE workspace_id = 'a8e1d905-297c-42f2-83cf-681f0cbf4ce5'
  AND stage = 'closing';