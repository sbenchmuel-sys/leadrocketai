-- Create meeting_packs table for storing meeting summaries, recaps, and follow-up emails
CREATE TABLE public.meeting_packs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  meeting_date DATE DEFAULT CURRENT_DATE,
  title TEXT,
  raw_notes TEXT,
  internal_recap_bullets JSONB DEFAULT '[]'::jsonb,
  open_questions JSONB DEFAULT '[]'::jsonb,
  milestones JSONB DEFAULT '[]'::jsonb,
  follow_up_email_subject TEXT,
  follow_up_email_body TEXT,
  milestones_saved_to_lead BOOLEAN NOT NULL DEFAULT false,
  email_saved_as_draft BOOLEAN NOT NULL DEFAULT false
);

-- Enable RLS
ALTER TABLE public.meeting_packs ENABLE ROW LEVEL SECURITY;

-- Create RLS policies
CREATE POLICY "Users can view their own meeting packs"
ON public.meeting_packs
FOR SELECT
USING (
  owner_user_id = auth.uid() 
  OR has_role(auth.uid(), 'admin'::app_role)
);

CREATE POLICY "Users can create their own meeting packs"
ON public.meeting_packs
FOR INSERT
WITH CHECK (auth.uid() = owner_user_id);

CREATE POLICY "Users can update their own meeting packs"
ON public.meeting_packs
FOR UPDATE
USING (
  owner_user_id = auth.uid() 
  OR has_role(auth.uid(), 'admin'::app_role)
);

CREATE POLICY "Users can delete their own meeting packs"
ON public.meeting_packs
FOR DELETE
USING (
  owner_user_id = auth.uid() 
  OR has_role(auth.uid(), 'admin'::app_role)
);

-- Create index for faster lookups by lead
CREATE INDEX idx_meeting_packs_lead_id ON public.meeting_packs(lead_id);
CREATE INDEX idx_meeting_packs_owner_user_id ON public.meeting_packs(owner_user_id);