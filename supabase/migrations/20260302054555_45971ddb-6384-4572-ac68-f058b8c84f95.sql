-- 1) Add lead_id column to contacts
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL;

-- 2) Index for workspace + lead_id lookups
CREATE INDEX IF NOT EXISTS idx_contacts_workspace_lead_id
  ON public.contacts(workspace_id, lead_id)
  WHERE lead_id IS NOT NULL;

-- 3) Drop and recreate view to add lead_id column
DROP VIEW IF EXISTS public.manager_conversation_metrics;

CREATE VIEW public.manager_conversation_metrics
WITH (security_invoker = on) AS
SELECT
  c.id AS conversation_id,
  c.workspace_id,
  c.contact_id,
  c.owner_user_id,
  c.channel,
  c.status,
  c.last_message_at,
  c.message_count,
  ct.display_name AS contact_name,
  ct.status AS contact_status,
  ct.company AS contact_company,
  ct.lead_id,
  ca.summary_text AS latest_summary,
  ca.sentiment AS latest_sentiment,
  ca.topics AS latest_topics,
  ca.extracted_features AS latest_features
FROM conversations c
JOIN contacts ct ON ct.id = c.contact_id
LEFT JOIN LATERAL (
  SELECT
    conversation_analysis.summary_text,
    conversation_analysis.sentiment,
    conversation_analysis.topics,
    conversation_analysis.extracted_features
  FROM conversation_analysis
  WHERE conversation_analysis.conversation_id = c.id
  ORDER BY conversation_analysis.created_at DESC
  LIMIT 1
) ca ON true;

-- 4) Safe backfill: link contacts to leads by email match within same workspace
UPDATE public.contacts ct
SET lead_id = matched.lead_id
FROM (
  SELECT DISTINCT ON (ci.contact_id)
    ci.contact_id,
    l.id AS lead_id
  FROM public.contact_identities ci
  JOIN public.conversations conv ON conv.contact_id = ci.contact_id
  JOIN public.leads l ON lower(ci.value) = lower(l.email)
    AND l.owner_user_id = conv.owner_user_id
  WHERE ci.type = 'email'
) matched
WHERE ct.id = matched.contact_id
  AND ct.lead_id IS NULL;