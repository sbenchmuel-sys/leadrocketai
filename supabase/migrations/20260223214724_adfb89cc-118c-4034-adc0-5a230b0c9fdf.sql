
ALTER TABLE public.gmail_connections 
  ALTER COLUMN access_token_encrypted TYPE text USING encode(access_token_encrypted, 'escape'),
  ALTER COLUMN refresh_token_encrypted TYPE text USING encode(refresh_token_encrypted, 'escape');
