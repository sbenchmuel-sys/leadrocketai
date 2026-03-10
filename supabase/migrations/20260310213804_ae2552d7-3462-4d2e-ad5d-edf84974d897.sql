
-- Add Sales Brain columns to kb_chunks
ALTER TABLE public.kb_chunks
  ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'knowledge',
  ADD COLUMN IF NOT EXISTS segment TEXT,
  ADD COLUMN IF NOT EXISTS tags TEXT[],
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 1;

-- Add index for content_type filtering
CREATE INDEX IF NOT EXISTS idx_kb_chunks_content_type ON public.kb_chunks(content_type);
