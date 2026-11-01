-- ═══════════════════════════════════════════════════════════════════
-- Members can see and update THEIR OWN mailbox (pre-pilot fix, 1 Nov 2026).
--
-- Since 20260525201531 the only mail_accounts policies are admin-only, so a user
-- with the 'rep' role could not see the mailbox they connected: Settings showed
-- "not connected", useMailSync found no mailbox and every manual send from the app
-- failed. Nobody noticed because every user so far was an admin of their own
-- workspace; the first pilot rep would have hit it on day one.
--
-- Token columns stay protected: SELECT on access_token / refresh_token is already
-- REVOKEd from authenticated (20260609184258), so this exposes only metadata.
-- ═══════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Users can view their own mail accounts" ON public.mail_accounts;
CREATE POLICY "Users can view their own mail accounts"
  ON public.mail_accounts
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.is_workspace_member(workspace_id, auth.uid()));

-- useMailSync flags needs_reconnect on the user's own row when a send hits an
-- expired token.
DROP POLICY IF EXISTS "Users can update their own mail accounts" ON public.mail_accounts;
CREATE POLICY "Users can update their own mail accounts"
  ON public.mail_accounts
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND public.is_workspace_member(workspace_id, auth.uid()))
  WITH CHECK (user_id = auth.uid() AND public.is_workspace_member(workspace_id, auth.uid()));
