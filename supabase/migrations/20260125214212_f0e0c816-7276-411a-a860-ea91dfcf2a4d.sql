-- Create workspace_profiles table for multi-tenant company/product configuration
CREATE TABLE public.workspace_profiles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  company_name TEXT,
  product_name TEXT,
  product_description TEXT,
  primary_value_props TEXT[] DEFAULT ARRAY[]::TEXT[],
  supported_use_cases TEXT[] DEFAULT ARRAY[]::TEXT[],
  allowed_claims TEXT[] DEFAULT ARRAY[]::TEXT[],
  disallowed_topics TEXT[] DEFAULT ARRAY[]::TEXT[],
  pricing_policy TEXT NOT NULL DEFAULT 'no_pricing_in_email',
  meeting_timezone TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT workspace_profiles_user_id_key UNIQUE (user_id),
  CONSTRAINT workspace_profiles_pricing_policy_check CHECK (pricing_policy IN ('no_pricing_in_email', 'pricing_allowed'))
);

-- Enable RLS
ALTER TABLE public.workspace_profiles ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own workspace profile"
  ON public.workspace_profiles
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own workspace profile"
  ON public.workspace_profiles
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own workspace profile"
  ON public.workspace_profiles
  FOR UPDATE
  USING (auth.uid() = user_id);

-- Trigger for updated_at
CREATE TRIGGER update_workspace_profiles_updated_at
  BEFORE UPDATE ON public.workspace_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();