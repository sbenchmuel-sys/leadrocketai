ALTER TABLE public.meeting_transcripts
  ADD COLUMN IF NOT EXISTS provider_error_detail TEXT;