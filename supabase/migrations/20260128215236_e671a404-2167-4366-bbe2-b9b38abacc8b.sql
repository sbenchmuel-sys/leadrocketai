-- Grant INSERT and UPDATE on gmail_connections to authenticated users
-- This allows them to have connections created for them via the OAuth flow
-- but still restricts SELECT on sensitive token columns

-- Grant INSERT on all columns (needed for OAuth callback to work)
-- Note: Service role already has full access, but we need to ensure 
-- authenticated users can have rows inserted for them
GRANT INSERT ON public.gmail_connections TO authenticated;
GRANT UPDATE ON public.gmail_connections TO authenticated;
GRANT DELETE ON public.gmail_connections TO authenticated;

-- Re-grant SELECT on safe columns (ensure it's applied correctly)
GRANT SELECT (id, user_id, gmail_email, token_expires_at, last_sync_at, created_at, updated_at) 
ON public.gmail_connections TO authenticated;