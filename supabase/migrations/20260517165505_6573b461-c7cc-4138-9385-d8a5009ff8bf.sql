ALTER TABLE public.meeting_ai_summaries
  ADD COLUMN IF NOT EXISTS followup_email_subject text,
  ADD COLUMN IF NOT EXISTS followup_email_body text;