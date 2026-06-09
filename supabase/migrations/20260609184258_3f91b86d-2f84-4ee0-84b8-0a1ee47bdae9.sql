
-- 1) mail_accounts: revoke client read access to plaintext OAuth token columns.
-- Admins can still read all other columns via existing RLS policy.
-- Edge functions use service_role which is unaffected.
REVOKE SELECT (access_token, refresh_token) ON public.mail_accounts FROM authenticated;
REVOKE SELECT (access_token, refresh_token) ON public.mail_accounts FROM anon;

-- 2) realtime.messages: default-deny RLS for broadcast/presence channels.
-- The app uses postgres_changes subscriptions (governed by RLS on source tables),
-- not broadcast or presence, so blocking direct realtime.messages access is safe
-- and prevents cross-workspace topic snooping.
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny all realtime broadcast access" ON realtime.messages;
CREATE POLICY "Deny all realtime broadcast access"
  ON realtime.messages
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);
