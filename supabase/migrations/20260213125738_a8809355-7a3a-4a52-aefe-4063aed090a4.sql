
CREATE OR REPLACE FUNCTION public.match_knowledge_chunks(
  query_embedding extensions.vector,
  match_threshold double precision DEFAULT 0.5,
  match_count integer DEFAULT 5,
  filter_customer_facing boolean DEFAULT true,
  filter_lead_id uuid DEFAULT NULL::uuid,
  p_owner_user_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(id uuid, content text, title text, source text, similarity double precision)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    kc.id,
    kc.content,
    kc.title,
    kc.source,
    1 - (kc.embedding <=> query_embedding) AS similarity
  FROM kb_chunks kc
  WHERE 
    kc.embedding IS NOT NULL
    AND kc.processing_status = 'completed'
    AND (NOT filter_customer_facing OR kc.allowed_customer_facing = true)
    AND (filter_lead_id IS NULL OR kc.lead_id IS NULL OR kc.lead_id = filter_lead_id)
    AND (p_owner_user_id IS NULL OR kc.owner_user_id = p_owner_user_id)
    AND 1 - (kc.embedding <=> query_embedding) > match_threshold
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$function$;
