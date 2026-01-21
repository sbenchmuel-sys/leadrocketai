-- Create rep_profiles table for user's profile information
CREATE TABLE public.rep_profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  full_name TEXT,
  email TEXT,
  phone TEXT,
  job_title TEXT,
  company_name TEXT,
  linkedin_url TEXT,
  calendar_link TEXT,
  office_address TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.rep_profiles ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Users can view their own rep profile" 
ON public.rep_profiles 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own rep profile" 
ON public.rep_profiles 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own rep profile" 
ON public.rep_profiles 
FOR UPDATE 
USING (auth.uid() = user_id);

-- Create trigger for updated_at
CREATE TRIGGER update_rep_profiles_updated_at
BEFORE UPDATE ON public.rep_profiles
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create rep_signatures table for email signatures
CREATE TABLE public.rep_signatures (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  signature_text TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.rep_signatures ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Users can view their own signatures" 
ON public.rep_signatures 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own signatures" 
ON public.rep_signatures 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own signatures" 
ON public.rep_signatures 
FOR UPDATE 
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own signatures" 
ON public.rep_signatures 
FOR DELETE 
USING (auth.uid() = user_id);

-- Add action_instructions column to leads table
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS action_instructions TEXT;