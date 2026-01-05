-- Ensure one profile per user for reliable maybeSingle/upsert
ALTER TABLE public.profiles
ADD CONSTRAINT profiles_user_id_unique UNIQUE (user_id);

-- Ensure one gmail connection per user as well
ALTER TABLE public.gmail_connections
ADD CONSTRAINT gmail_connections_user_id_unique UNIQUE (user_id);
