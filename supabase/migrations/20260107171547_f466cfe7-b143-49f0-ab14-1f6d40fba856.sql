-- Create org_settings table for organization-level settings
CREATE TABLE public.org_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  zoom_meeting_sync_enabled BOOLEAN NOT NULL DEFAULT true,
  zoom_auto_generate_followups_enabled BOOLEAN NOT NULL DEFAULT true,
  internal_email_domains TEXT[] DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT org_settings_user_id_key UNIQUE (user_id)
);

-- Enable RLS
ALTER TABLE public.org_settings ENABLE ROW LEVEL SECURITY;

-- RLS policies for org_settings
CREATE POLICY "Users can view their own org settings"
ON public.org_settings
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own org settings"
ON public.org_settings
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own org settings"
ON public.org_settings
FOR UPDATE
USING (auth.uid() = user_id);

-- Trigger for updated_at
CREATE TRIGGER update_org_settings_updated_at
BEFORE UPDATE ON public.org_settings
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create meeting_summaries table for Zoom meeting summaries
CREATE TABLE public.meeting_summaries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  lead_id UUID REFERENCES public.leads(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'zoom_email',
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  sent_at TIMESTAMP WITH TIME ZONE NOT NULL,
  meeting_title TEXT,
  summary_text TEXT,
  participants_emails TEXT[] DEFAULT ARRAY[]::TEXT[],
  processed_at TIMESTAMP WITH TIME ZONE,
  followup_generated BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT meeting_summaries_gmail_message_id_key UNIQUE (gmail_message_id)
);

-- Enable RLS
ALTER TABLE public.meeting_summaries ENABLE ROW LEVEL SECURITY;

-- RLS policies for meeting_summaries
CREATE POLICY "Users can view their own meeting summaries"
ON public.meeting_summaries
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own meeting summaries"
ON public.meeting_summaries
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own meeting summaries"
ON public.meeting_summaries
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own meeting summaries"
ON public.meeting_summaries
FOR DELETE
USING (auth.uid() = user_id);

-- Index for fast lead lookup
CREATE INDEX idx_meeting_summaries_lead_id ON public.meeting_summaries(lead_id);
CREATE INDEX idx_meeting_summaries_gmail_thread_id ON public.meeting_summaries(gmail_thread_id);

-- Create unmatched_meeting_summaries table for the ambiguous/unmatched queue
CREATE TABLE public.unmatched_meeting_summaries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT,
  meeting_title TEXT,
  sent_at TIMESTAMP WITH TIME ZONE NOT NULL,
  summary_text TEXT,
  participants_emails TEXT[] DEFAULT ARRAY[]::TEXT[],
  suggested_leads JSONB DEFAULT '[]'::JSONB,
  resolved_at TIMESTAMP WITH TIME ZONE,
  resolved_lead_id UUID REFERENCES public.leads(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT unmatched_meeting_summaries_gmail_message_id_key UNIQUE (gmail_message_id)
);

-- Enable RLS
ALTER TABLE public.unmatched_meeting_summaries ENABLE ROW LEVEL SECURITY;

-- RLS policies for unmatched_meeting_summaries
CREATE POLICY "Users can view their own unmatched summaries"
ON public.unmatched_meeting_summaries
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own unmatched summaries"
ON public.unmatched_meeting_summaries
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own unmatched summaries"
ON public.unmatched_meeting_summaries
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own unmatched summaries"
ON public.unmatched_meeting_summaries
FOR DELETE
USING (auth.uid() = user_id);

-- Index for fast lookup
CREATE INDEX idx_unmatched_meeting_summaries_user_id ON public.unmatched_meeting_summaries(user_id);
CREATE INDEX idx_unmatched_meeting_summaries_resolved ON public.unmatched_meeting_summaries(resolved_at) WHERE resolved_at IS NULL;