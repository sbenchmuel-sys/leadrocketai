CREATE POLICY "Service role can manage manager_views" ON public.manager_views FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Workspace members can view automation settings" ON public.workspace_automation_settings FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id, auth.uid()));