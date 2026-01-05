-- Create app_role enum for role-based access
CREATE TYPE public.app_role AS ENUM ('admin', 'sales');

-- Create profiles table
CREATE TABLE public.profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL DEFAULT 'sales',
  onboarding_step INTEGER NOT NULL DEFAULT 0,
  onboarding_done BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create leads table
CREATE TABLE public.leads (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('fast', 'nurture')),
  status TEXT NOT NULL DEFAULT 'new',
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  meeting_link TEXT,
  personal_notes TEXT,
  pref_email_drafts BOOLEAN NOT NULL DEFAULT true,
  pref_linkedin_drafts BOOLEAN NOT NULL DEFAULT true,
  milestones_json JSONB,
  risks_json JSONB,
  next_step TEXT,
  next_step_reason TEXT,
  deal_outlook TEXT CHECK (deal_outlook IS NULL OR deal_outlook IN ('positive', 'neutral', 'negative')),
  deal_factors_json JSONB,
  last_ai_run_at TIMESTAMP WITH TIME ZONE
);

-- Create interactions table
CREATE TABLE public.interactions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  subject TEXT,
  from_email TEXT,
  to_email TEXT,
  body_text TEXT NOT NULL,
  ai_summary TEXT,
  ai_intent TEXT,
  ai_reply_worthy BOOLEAN
);

-- Create drafts table
CREATE TABLE public.drafts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'linkedin')),
  draft_type TEXT NOT NULL,
  to_recipient TEXT,
  subject TEXT,
  body_text TEXT NOT NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'sent', 'discarded'))
);

-- Create kb_chunks table for knowledge base
CREATE TABLE public.kb_chunks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  content TEXT NOT NULL,
  title TEXT,
  source TEXT,
  allowed_customer_facing BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_chunks ENABLE ROW LEVEL SECURITY;

-- Create security definer function to check role
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE user_id = _user_id AND role = _role
  )
$$;

-- Profiles policies
CREATE POLICY "Users can view their own profile"
ON public.profiles FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own profile"
ON public.profiles FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own profile"
ON public.profiles FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Leads policies
CREATE POLICY "Users can view their own leads or admins can view all"
ON public.leads FOR SELECT
USING (
  auth.uid() = owner_user_id OR public.has_role(auth.uid(), 'admin')
);

CREATE POLICY "Users can create their own leads"
ON public.leads FOR INSERT
WITH CHECK (auth.uid() = owner_user_id);

CREATE POLICY "Users can update their own leads or admins can update all"
ON public.leads FOR UPDATE
USING (
  auth.uid() = owner_user_id OR public.has_role(auth.uid(), 'admin')
);

CREATE POLICY "Users can delete their own leads"
ON public.leads FOR DELETE
USING (auth.uid() = owner_user_id);

-- Interactions policies (based on lead ownership)
CREATE POLICY "Users can view interactions for their leads"
ON public.interactions FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.leads
    WHERE leads.id = interactions.lead_id
    AND (leads.owner_user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  )
);

CREATE POLICY "Users can create interactions for their leads"
ON public.interactions FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.leads
    WHERE leads.id = lead_id
    AND (leads.owner_user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  )
);

CREATE POLICY "Users can update interactions for their leads"
ON public.interactions FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.leads
    WHERE leads.id = interactions.lead_id
    AND (leads.owner_user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  )
);

-- Drafts policies (based on lead ownership)
CREATE POLICY "Users can view drafts for their leads"
ON public.drafts FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.leads
    WHERE leads.id = drafts.lead_id
    AND (leads.owner_user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  )
);

CREATE POLICY "Users can create drafts for their leads"
ON public.drafts FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.leads
    WHERE leads.id = lead_id
    AND (leads.owner_user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  )
);

CREATE POLICY "Users can update drafts for their leads"
ON public.drafts FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.leads
    WHERE leads.id = drafts.lead_id
    AND (leads.owner_user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  )
);

-- KB chunks policies (readable by all authenticated users)
CREATE POLICY "Authenticated users can view kb_chunks"
ON public.kb_chunks FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Only admins can modify kb_chunks"
ON public.kb_chunks FOR ALL
USING (public.has_role(auth.uid(), 'admin'));

-- Create trigger for profiles on new user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, role, onboarding_step, onboarding_done)
  VALUES (NEW.id, 'sales', 0, false);
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Add updated_at triggers
CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Create indexes for performance
CREATE INDEX idx_leads_owner ON public.leads(owner_user_id);
CREATE INDEX idx_leads_last_activity ON public.leads(last_activity_at DESC);
CREATE INDEX idx_interactions_lead ON public.interactions(lead_id);
CREATE INDEX idx_interactions_occurred ON public.interactions(occurred_at DESC);
CREATE INDEX idx_drafts_lead ON public.drafts(lead_id);
CREATE INDEX idx_kb_chunks_customer_facing ON public.kb_chunks(allowed_customer_facing);