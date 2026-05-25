
-- =====================================================
-- Security hardening: restrict service-role policies and storage access
-- =====================================================

-- 1. CALL TABLES: restrict service-role policies to service_role only
DROP POLICY IF EXISTS "Service role can manage call sessions" ON public.call_sessions;
CREATE POLICY "Service role can manage call sessions"
  ON public.call_sessions
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role can manage call analyses" ON public.call_analyses;
CREATE POLICY "Service role can manage call analyses"
  ON public.call_analyses
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role can manage call transcripts" ON public.call_transcripts;
CREATE POLICY "Service role can manage call transcripts"
  ON public.call_transcripts
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role can manage call recordings" ON public.call_recordings;
CREATE POLICY "Service role can manage call recordings"
  ON public.call_recordings
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role can manage call webhook log" ON public.call_webhook_log;
CREATE POLICY "Service role can manage call webhook log"
  ON public.call_webhook_log
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 2. ENTITY ENRICHMENT: restrict service-role policy to service_role
DROP POLICY IF EXISTS "Service role full access on entity_enrichment" ON public.entity_enrichment;
CREATE POLICY "Service role full access on entity_enrichment"
  ON public.entity_enrichment
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 3. STORAGE: scope call-recordings bucket reads to workspace members
DROP POLICY IF EXISTS "Workspace members can read call recordings storage" ON storage.objects;
DROP POLICY IF EXISTS "Service role can manage call recordings storage" ON storage.objects;

CREATE POLICY "Service role manages call recordings storage"
  ON storage.objects
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (bucket_id = 'call-recordings')
  WITH CHECK (bucket_id = 'call-recordings');

CREATE POLICY "Workspace members can read own call recordings"
  ON storage.objects
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'call-recordings'
    AND EXISTS (
      SELECT 1
      FROM public.call_recordings cr
      JOIN public.call_sessions cs ON cs.id = cr.call_session_id
      WHERE cr.storage_path = storage.objects.name
        AND public.is_workspace_member(cs.workspace_id, auth.uid())
    )
  );

-- 4. MAIL_ACCOUNTS: restrict SELECT (which exposes OAuth tokens) to workspace admins only.
-- Plaintext token columns remain; only privileged roles can read them.
-- Edge functions using the service_role key are unaffected.
DROP POLICY IF EXISTS "Workspace members can view mail accounts" ON public.mail_accounts;

CREATE POLICY "Workspace admins can view mail accounts"
  ON public.mail_accounts
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_workspace_admin(workspace_id, auth.uid()));
