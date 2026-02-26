
-- Add unique constraint on call_transcripts(call_session_id) for idempotency
ALTER TABLE public.call_transcripts
  ADD CONSTRAINT call_transcripts_call_session_id_key UNIQUE (call_session_id);

-- Add unique constraint on call_analyses(call_session_id) for idempotency
ALTER TABLE public.call_analyses
  ADD CONSTRAINT call_analyses_call_session_id_key UNIQUE (call_session_id);

-- Add new transcript text columns to preserve raw/clean/formatted versions
ALTER TABLE public.call_transcripts
  ADD COLUMN raw_full_text text,
  ADD COLUMN clean_full_text text,
  ADD COLUMN llm_formatted_text text;
