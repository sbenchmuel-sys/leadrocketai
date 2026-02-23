
-- ═══════════════════════════════════════════════════════════
-- FIX 1: Column-level security for integrations table
-- Hide credentials_encrypted and app_secret_encrypted from authenticated users
-- ═══════════════════════════════════════════════════════════

REVOKE SELECT ON public.integrations FROM authenticated;
GRANT SELECT (id, user_id, workspace_id, type, provider, provider_account_id, webhook_verify_token, is_active, last_sync_at, created_at, updated_at)
ON public.integrations TO authenticated;

-- ═══════════════════════════════════════════════════════════
-- FIX 2: Database-level message expiry function
-- Ensures expired message bodies are cleaned up even if edge function fails
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.expire_old_messages()
RETURNS void AS $$
BEGIN
  UPDATE public.messages 
  SET body_ciphertext = NULL 
  WHERE expires_at < NOW() 
  AND body_ciphertext IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public';

-- Schedule hourly cleanup via pg_cron
SELECT cron.schedule(
  'expire-messages',
  '0 * * * *',
  $$SELECT public.expire_old_messages()$$
);

-- ═══════════════════════════════════════════════════════════
-- FIX 3: Secure match_knowledge_chunks SECURITY DEFINER functions
-- Add auth.uid() validation to prevent cross-user KB access
-- ═══════════════════════════════════════════════════════════

-- Fix the version with p_owner_user_id parameter (main concern)
CREATE OR REPLACE FUNCTION public.match_knowledge_chunks(
  query_embedding extensions.vector,
  match_threshold double precision DEFAULT 0.5,
  match_count integer DEFAULT 5,
  filter_customer_facing boolean DEFAULT true,
  filter_lead_id uuid DEFAULT NULL::uuid,
  p_owner_user_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(id uuid, content text, title text, source text, similarity double precision)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Validate caller: authenticated users can only query their own knowledge
  IF auth.uid() IS NOT NULL AND p_owner_user_id IS NOT NULL AND p_owner_user_id != auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized: Cannot access other users knowledge base';
  END IF;

  RETURN QUERY
  SELECT 
    kc.id,
    kc.content,
    kc.title,
    kc.source,
    1 - (kc.embedding <=> query_embedding) AS similarity
  FROM kb_chunks kc
  WHERE 
    kc.embedding IS NOT NULL
    AND kc.processing_status = 'completed'
    AND (NOT filter_customer_facing OR kc.allowed_customer_facing = true)
    AND (filter_lead_id IS NULL OR kc.lead_id IS NULL OR kc.lead_id = filter_lead_id)
    AND (p_owner_user_id IS NULL OR kc.owner_user_id = p_owner_user_id)
    AND 1 - (kc.embedding <=> query_embedding) > match_threshold
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$function$;
