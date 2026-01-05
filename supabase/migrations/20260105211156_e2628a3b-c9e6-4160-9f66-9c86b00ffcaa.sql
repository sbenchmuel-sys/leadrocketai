-- Create gmail_connections table for storing OAuth tokens
CREATE TABLE public.gmail_connections (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  gmail_email TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  last_sync_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.gmail_connections ENABLE ROW LEVEL SECURITY;

-- Users can only view their own Gmail connection
CREATE POLICY "Users can view their own gmail connection"
ON public.gmail_connections
FOR SELECT
USING (auth.uid() = user_id);

-- Users can insert their own Gmail connection
CREATE POLICY "Users can insert their own gmail connection"
ON public.gmail_connections
FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Users can update their own Gmail connection
CREATE POLICY "Users can update their own gmail connection"
ON public.gmail_connections
FOR UPDATE
USING (auth.uid() = user_id);

-- Users can delete their own Gmail connection
CREATE POLICY "Users can delete their own gmail connection"
ON public.gmail_connections
FOR DELETE
USING (auth.uid() = user_id);

-- Create trigger for automatic timestamp updates
CREATE TRIGGER update_gmail_connections_updated_at
BEFORE UPDATE ON public.gmail_connections
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();