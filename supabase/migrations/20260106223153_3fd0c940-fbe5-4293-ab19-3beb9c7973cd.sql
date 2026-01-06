-- Add gmail_thread_id and direction to interactions table
ALTER TABLE public.interactions 
ADD COLUMN IF NOT EXISTS gmail_thread_id text,
ADD COLUMN IF NOT EXISTS direction text;

-- Create index for thread-based lookups
CREATE INDEX IF NOT EXISTS idx_interactions_gmail_thread_id ON public.interactions(gmail_thread_id);

-- Add stage and action fields to leads table
ALTER TABLE public.leads
ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'new',
ADD COLUMN IF NOT EXISTS needs_action boolean NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS next_action_key text,
ADD COLUMN IF NOT EXISTS next_action_label text,
ADD COLUMN IF NOT EXISTS first_outbound_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS last_outbound_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS last_inbound_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS meeting_summary_count integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS nurture_outbound_count integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_nurture_outbound_at timestamp with time zone;

-- Create index for needs_action queries (dashboard performance)
CREATE INDEX IF NOT EXISTS idx_leads_needs_action ON public.leads(needs_action) WHERE needs_action = true;
CREATE INDEX IF NOT EXISTS idx_leads_stage ON public.leads(stage);