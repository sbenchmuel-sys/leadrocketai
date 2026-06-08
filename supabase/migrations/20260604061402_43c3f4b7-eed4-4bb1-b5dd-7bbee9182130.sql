DROP FUNCTION IF EXISTS public.match_knowledge_chunks_v2(
  extensions.vector, uuid, double precision, integer, boolean, uuid, text[]
);

CREATE OR REPLACE FUNCTION public.match_knowledge_chunks_v2(
  query_embedding extensions.vector,
  p_owner_user_id uuid,
  match_threshold double precision DEFAULT 0.5,
  match_count integer DEFAULT 5,
  filter_customer_facing boolean DEFAULT true,
  filter_lead_id uuid DEFAULT NULL::uuid,
  filter_content_types text[] DEFAULT NULL::text[],
  filter_document_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(id uuid, content text, title text, source text, content_type text, segment text, tags text[], priority integer, similarity double precision)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.content,
    kc.title,
    kc.source,
    kc.content_type,
    kc.segment,
    kc.tags,
    kc.priority,
    1 - (kc.embedding <=> query_embedding) AS similarity
  FROM kb_chunks kc
  WHERE
    kc.embedding IS NOT NULL
    AND kc.processing_status = 'completed'
    AND kc.owner_user_id = p_owner_user_id
    AND (NOT filter_customer_facing OR kc.allowed_customer_facing = true)
    AND (filter_lead_id IS NULL OR kc.lead_id IS NULL OR kc.lead_id = filter_lead_id)
    AND (filter_content_types IS NULL OR kc.content_type = ANY(filter_content_types))
    AND (filter_document_id IS NULL OR kc.document_id = filter_document_id)
    AND 1 - (kc.embedding <=> query_embedding) > match_threshold
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS knowledge_document_id uuid;

COMMENT ON COLUMN public.campaigns.knowledge_document_id IS
  'kb_chunks.document_id of the campaign''s uploaded knowledge file (set by process-knowledge-document). Authoring-time KB retrieval is scoped to this document via match_knowledge_chunks_v2(filter_document_id).';