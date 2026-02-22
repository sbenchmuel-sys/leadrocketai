
-- 1. Add provider column to integrations (default 'meta' for existing rows)
ALTER TABLE public.integrations
ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'meta';

-- 2. Add app_secret column for webhook signature validation (encrypted, per-integration)
ALTER TABLE public.integrations
ADD COLUMN IF NOT EXISTS app_secret_encrypted text;

-- 3. Create the WhatsApp event queue table
CREATE TABLE public.whatsapp_event_queue (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  error_message text,
  event_type text NOT NULL,  -- 'message_inbound', 'status_update', etc.
  workspace_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'meta',
  raw_payload jsonb NOT NULL,
  idempotency_key text NOT NULL,
  CONSTRAINT whatsapp_event_queue_integration_fkey FOREIGN KEY (integration_id) REFERENCES public.integrations(id) ON DELETE CASCADE
);

-- Unique constraint for idempotency (prevent duplicate processing)
CREATE UNIQUE INDEX idx_whatsapp_event_queue_idempotency
ON public.whatsapp_event_queue (idempotency_key);

-- Index for efficient queue polling
CREATE INDEX idx_whatsapp_event_queue_pending
ON public.whatsapp_event_queue (status, created_at)
WHERE status = 'pending';

-- Enable RLS
ALTER TABLE public.whatsapp_event_queue ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (queue is backend-only)
CREATE POLICY "Service role full access on whatsapp_event_queue"
ON public.whatsapp_event_queue
FOR ALL
USING (true)
WITH CHECK (true);

-- Workspace members can view queue entries (for debugging in UI if needed)
CREATE POLICY "Workspace members can view queue entries"
ON public.whatsapp_event_queue
FOR SELECT
USING (is_workspace_member(workspace_id, auth.uid()));
