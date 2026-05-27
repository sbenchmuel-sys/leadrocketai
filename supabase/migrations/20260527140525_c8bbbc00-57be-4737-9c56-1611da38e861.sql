
-- ============================================================
-- 1. mail_accounts: revoke plaintext token columns from end users.
--    Service role retains full access; encryption already enforced at write time.
-- ============================================================
REVOKE SELECT (access_token, refresh_token) ON public.mail_accounts FROM authenticated;
REVOKE SELECT (access_token, refresh_token) ON public.mail_accounts FROM anon;
REVOKE UPDATE (access_token, refresh_token) ON public.mail_accounts FROM authenticated;
REVOKE INSERT (access_token, refresh_token) ON public.mail_accounts FROM authenticated;

-- ============================================================
-- 2. kb_chunks: remove `owner_user_id IS NULL` bypass that let any
--    authenticated user read unowned chunks across workspaces.
-- ============================================================
DROP POLICY IF EXISTS "Users can view their own kb_chunks or shared" ON public.kb_chunks;
CREATE POLICY "Users can view their own kb_chunks"
ON public.kb_chunks FOR SELECT
TO authenticated
USING (owner_user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update their own kb_chunks or admins" ON public.kb_chunks;
CREATE POLICY "Users can update their own kb_chunks"
ON public.kb_chunks FOR UPDATE
TO authenticated
USING (owner_user_id = auth.uid());

DROP POLICY IF EXISTS "Users can delete their own kb_chunks or admins" ON public.kb_chunks;
CREATE POLICY "Users can delete their own kb_chunks"
ON public.kb_chunks FOR DELETE
TO authenticated
USING (owner_user_id = auth.uid());

-- ============================================================
-- 3. leads: replace global `has_role(...,'admin')` bypass with
--    workspace-scoped admin check.
-- ============================================================
DROP POLICY IF EXISTS "Users can view their own leads or admins can view all" ON public.leads;
CREATE POLICY "Users can view their own leads or workspace admins"
ON public.leads FOR SELECT
TO authenticated
USING (
  auth.uid() = owner_user_id
  OR public.is_workspace_admin(workspace_id, auth.uid())
);

DROP POLICY IF EXISTS "Users can update their own leads or admins can update all" ON public.leads;
CREATE POLICY "Users can update their own leads or workspace admins"
ON public.leads FOR UPDATE
TO authenticated
USING (
  auth.uid() = owner_user_id
  OR public.is_workspace_admin(workspace_id, auth.uid())
);

-- ============================================================
-- 4. interactions: scope admin bypass to the lead's workspace.
-- ============================================================
DROP POLICY IF EXISTS "Users can view interactions for their leads" ON public.interactions;
CREATE POLICY "Users can view interactions for their leads"
ON public.interactions FOR SELECT
TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.leads
  WHERE leads.id = interactions.lead_id
    AND (leads.owner_user_id = auth.uid()
         OR public.is_workspace_admin(leads.workspace_id, auth.uid()))
));

DROP POLICY IF EXISTS "Users can create interactions for their leads" ON public.interactions;
CREATE POLICY "Users can create interactions for their leads"
ON public.interactions FOR INSERT
TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM public.leads
  WHERE leads.id = interactions.lead_id
    AND (leads.owner_user_id = auth.uid()
         OR public.is_workspace_admin(leads.workspace_id, auth.uid()))
));

DROP POLICY IF EXISTS "Users can update interactions for their leads" ON public.interactions;
CREATE POLICY "Users can update interactions for their leads"
ON public.interactions FOR UPDATE
TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.leads
  WHERE leads.id = interactions.lead_id
    AND (leads.owner_user_id = auth.uid()
         OR public.is_workspace_admin(leads.workspace_id, auth.uid()))
));

-- ============================================================
-- 5. lead_signals: same fix.
-- ============================================================
DROP POLICY IF EXISTS "Users can view signals for their leads" ON public.lead_signals;
CREATE POLICY "Users can view signals for their leads"
ON public.lead_signals FOR SELECT
TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.leads
  WHERE leads.id = lead_signals.lead_id
    AND (leads.owner_user_id = auth.uid()
         OR public.is_workspace_admin(leads.workspace_id, auth.uid()))
));

DROP POLICY IF EXISTS "Users can insert signals for their leads" ON public.lead_signals;
CREATE POLICY "Users can insert signals for their leads"
ON public.lead_signals FOR INSERT
TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM public.leads
  WHERE leads.id = lead_signals.lead_id
    AND (leads.owner_user_id = auth.uid()
         OR public.is_workspace_admin(leads.workspace_id, auth.uid()))
));

DROP POLICY IF EXISTS "Users can delete signals for their leads" ON public.lead_signals;
CREATE POLICY "Users can delete signals for their leads"
ON public.lead_signals FOR DELETE
TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.leads
  WHERE leads.id = lead_signals.lead_id
    AND (leads.owner_user_id = auth.uid()
         OR public.is_workspace_admin(leads.workspace_id, auth.uid()))
));

-- ============================================================
-- 6. drafts: same fix.
-- ============================================================
DROP POLICY IF EXISTS "Users can view drafts for their leads" ON public.drafts;
CREATE POLICY "Users can view drafts for their leads"
ON public.drafts FOR SELECT
TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.leads
  WHERE leads.id = drafts.lead_id
    AND (leads.owner_user_id = auth.uid()
         OR public.is_workspace_admin(leads.workspace_id, auth.uid()))
));

DROP POLICY IF EXISTS "Users can create drafts for their leads" ON public.drafts;
CREATE POLICY "Users can create drafts for their leads"
ON public.drafts FOR INSERT
TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM public.leads
  WHERE leads.id = drafts.lead_id
    AND (leads.owner_user_id = auth.uid()
         OR public.is_workspace_admin(leads.workspace_id, auth.uid()))
));

DROP POLICY IF EXISTS "Users can update drafts for their leads" ON public.drafts;
CREATE POLICY "Users can update drafts for their leads"
ON public.drafts FOR UPDATE
TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.leads
  WHERE leads.id = drafts.lead_id
    AND (leads.owner_user_id = auth.uid()
         OR public.is_workspace_admin(leads.workspace_id, auth.uid()))
));

DROP POLICY IF EXISTS "Users can delete drafts for their leads" ON public.drafts;
CREATE POLICY "Users can delete drafts for their leads"
ON public.drafts FOR DELETE
TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.leads
  WHERE leads.id = drafts.lead_id
    AND (leads.owner_user_id = auth.uid()
         OR public.is_workspace_admin(leads.workspace_id, auth.uid()))
));

-- ============================================================
-- 7. meeting_packs: replace global admin bypass with workspace-scoped.
-- ============================================================
DROP POLICY IF EXISTS "Users can view their own meeting packs" ON public.meeting_packs;
CREATE POLICY "Users can view their own meeting packs"
ON public.meeting_packs FOR SELECT
TO authenticated
USING (
  owner_user_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.leads
    WHERE leads.id = meeting_packs.lead_id
      AND public.is_workspace_admin(leads.workspace_id, auth.uid())
  )
);

DROP POLICY IF EXISTS "Users can update their own meeting packs" ON public.meeting_packs;
CREATE POLICY "Users can update their own meeting packs"
ON public.meeting_packs FOR UPDATE
TO authenticated
USING (
  owner_user_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.leads
    WHERE leads.id = meeting_packs.lead_id
      AND public.is_workspace_admin(leads.workspace_id, auth.uid())
  )
);

DROP POLICY IF EXISTS "Users can delete their own meeting packs" ON public.meeting_packs;
CREATE POLICY "Users can delete their own meeting packs"
ON public.meeting_packs FOR DELETE
TO authenticated
USING (
  owner_user_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.leads
    WHERE leads.id = meeting_packs.lead_id
      AND public.is_workspace_admin(leads.workspace_id, auth.uid())
  )
);

-- ============================================================
-- 8. workspace_automation_settings: restrict reads to admins only.
-- ============================================================
DROP POLICY IF EXISTS "Workspace admins can manage automation settings" ON public.workspace_automation_settings;
CREATE POLICY "Workspace admins can manage automation settings"
ON public.workspace_automation_settings FOR ALL
TO authenticated
USING (public.is_workspace_admin(workspace_id, auth.uid()))
WITH CHECK (public.is_workspace_admin(workspace_id, auth.uid()));
