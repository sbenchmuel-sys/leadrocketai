-- Revoke SELECT on sensitive token columns from authenticated users
-- This ensures only service role (used by edge functions) can read tokens
-- while regular authenticated users can still query non-sensitive fields

-- First, revoke all column permissions and re-grant only safe columns
REVOKE SELECT ON public.gmail_connections FROM authenticated;
REVOKE SELECT ON public.gmail_connections FROM anon;

-- Grant SELECT only on non-sensitive columns to authenticated users
GRANT SELECT (id, user_id, gmail_email, token_expires_at, last_sync_at, created_at, updated_at) 
ON public.gmail_connections TO authenticated;

-- Service role (used by edge functions) retains full access by default
-- No changes needed for service_role as it has superuser-like privileges

-- Add a comment documenting this security measure
COMMENT ON COLUMN public.gmail_connections.access_token IS 'Encrypted OAuth access token - only accessible by backend edge functions via service role';
COMMENT ON COLUMN public.gmail_connections.refresh_token IS 'Encrypted OAuth refresh token - only accessible by backend edge functions via service role';