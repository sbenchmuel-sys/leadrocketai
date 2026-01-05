-- Create a table for storing OAuth state tokens with CSRF validation
CREATE TABLE public.oauth_states (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  csrf_token TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

-- Enable RLS
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;

-- Users can only see their own states
CREATE POLICY "Users can view their own oauth states"
  ON public.oauth_states FOR SELECT
  USING (auth.uid() = user_id);

-- Users can insert their own states
CREATE POLICY "Users can create their own oauth states"
  ON public.oauth_states FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can delete their own states
CREATE POLICY "Users can delete their own oauth states"
  ON public.oauth_states FOR DELETE
  USING (auth.uid() = user_id);

-- Create index on user_id and csrf_token for fast lookups
CREATE INDEX idx_oauth_states_user_csrf ON public.oauth_states(user_id, csrf_token);

-- Create index on expires_at for cleanup
CREATE INDEX idx_oauth_states_expires ON public.oauth_states(expires_at);