-- Add gmail_message_id column for deduplication
ALTER TABLE public.interactions 
ADD COLUMN gmail_message_id text;

-- Create unique constraint to prevent duplicates at database level
CREATE UNIQUE INDEX idx_interactions_gmail_message_unique 
ON public.interactions (lead_id, gmail_message_id) 
WHERE gmail_message_id IS NOT NULL;

-- Clean up existing duplicate emails (keep oldest by id)
DELETE FROM public.interactions a
USING public.interactions b
WHERE a.source = 'gmail' 
  AND b.source = 'gmail'
  AND a.lead_id = b.lead_id 
  AND a.subject = b.subject
  AND a.from_email = b.from_email
  AND a.id > b.id;