-- 20260517155730_add_followup_email_to_meeting_ai_summaries.sql
--
-- Phase 3: the meeting analyzer produces a customer follow-up email
-- (subject + body) as part of post_meeting_recap. meeting_ai_summaries
-- has no slot for it today. Add two nullable text columns so the
-- analyzer can persist the draft alongside the rest of the recap.
--
-- Nullable + no default: pre-Phase-3 rows (none today) and analyzer
-- runs that fail to produce a customer_email block both stay valid.

ALTER TABLE public.meeting_ai_summaries
  ADD COLUMN IF NOT EXISTS followup_email_subject text,
  ADD COLUMN IF NOT EXISTS followup_email_body text;
