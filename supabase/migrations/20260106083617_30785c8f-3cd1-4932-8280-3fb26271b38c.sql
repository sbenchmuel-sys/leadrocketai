-- Enable vector extension for embeddings
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- Add new columns to kb_chunks for document/chunk management
ALTER TABLE public.kb_chunks 
ADD COLUMN IF NOT EXISTS embedding vector(768),
ADD COLUMN IF NOT EXISTS document_id uuid,
ADD COLUMN IF NOT EXISTS chunk_index integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS processing_status text DEFAULT 'pending';

-- Create index for fast similarity search
CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding ON public.kb_chunks 
USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Create index for document grouping
CREATE INDEX IF NOT EXISTS idx_kb_chunks_document_id ON public.kb_chunks(document_id);

-- Function to match knowledge chunks by semantic similarity
CREATE OR REPLACE FUNCTION public.match_knowledge_chunks(
  query_embedding vector(768),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 5,
  filter_customer_facing boolean DEFAULT true
)
RETURNS TABLE (
  id uuid,
  content text,
  title text,
  source text,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    AND 1 - (kc.embedding <=> query_embedding) > match_threshold
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;