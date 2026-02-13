CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_kb_chunks_content_trgm ON kb_chunks USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_owner_status ON kb_chunks (owner_user_id, processing_status)
  WHERE processing_status = 'completed';