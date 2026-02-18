-- Add message delivery status tracking for WhatsApp
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'delivered', 'read', 'failed'));

-- Add last_read_at to leads for WhatsApp read-receipt intelligence
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS last_read_at timestamp with time zone;

-- Index for fast status lookups by provider_message_id (already used for idempotency)
CREATE INDEX IF NOT EXISTS idx_messages_provider_message_id
  ON public.messages (provider_message_id)
  WHERE provider_message_id IS NOT NULL;