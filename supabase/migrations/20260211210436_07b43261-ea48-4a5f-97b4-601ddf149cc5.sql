
-- Add summary_short column for the 2-sentence summary
ALTER TABLE public.conversation_analysis
ADD COLUMN IF NOT EXISTS summary_short text;

-- Add recommended_reply_channel column
ALTER TABLE public.conversation_analysis
ADD COLUMN IF NOT EXISTS recommended_reply_channel text;

-- Add urgency column
ALTER TABLE public.conversation_analysis
ADD COLUMN IF NOT EXISTS urgency text;

-- Add index on conversation_id + created_at for latest analysis lookup
CREATE INDEX IF NOT EXISTS idx_conversation_analysis_convo_latest
ON public.conversation_analysis (conversation_id, created_at DESC);

-- Add index on contact_id for contact-level analysis queries
CREATE INDEX IF NOT EXISTS idx_conversation_analysis_contact
ON public.conversation_analysis (contact_id, created_at DESC);
