-- ============================================================================
-- Outreach Unit B (Phase 2) — scope KB retrieval to a campaign's own document.
--
-- 1. Re-create match_knowledge_chunks_v2 with a TRAILING optional
--    filter_document_id param (default NULL). All existing args, defaults,
--    and the RETURNS TABLE column set + order (incl. priority) are preserved
--    byte-for-byte, so the sole caller (ai_task ~L819) keeps working when it
--    omits the new arg. When provided, results are restricted to chunks whose
--    kb_chunks.document_id matches — i.e. one uploaded campaign knowledge file.
--
-- 2. Add campaigns.knowledge_document_id — the durable link from a campaign to
--    the kb_chunks.document_id produced by process-knowledge-document at upload.
--    Distinct from the lightweight knowledge_ref text pointer added in Unit A.
--
-- match_knowledge_chunks_v2 is the canonical RPC (v1 + unnumbered are deprecated;
-- do not reintroduce). This migration is a DROP-then-CREATE of the v2 signature
-- only — it does not touch the deprecated variants.
-- ============================================================================

-- Drop the EXACT current signature (7 args) before recreating with 8.
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

-- Durable campaign → knowledge-document link (kb_chunks.document_id).
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS knowledge_document_id uuid;

COMMENT ON COLUMN public.campaigns.knowledge_document_id IS
  'kb_chunks.document_id of the campaign''s uploaded knowledge file (set by process-knowledge-document). Authoring-time KB retrieval is scoped to this document via match_knowledge_chunks_v2(filter_document_id).';
