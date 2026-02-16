DROP POLICY IF EXISTS "Admins can insert workspace members" ON public.workspace_members;

CREATE POLICY "Admins or first member can insert workspace members"
  ON public.workspace_members
  FOR INSERT
  TO authenticated
  WITH CHECK (
    is_workspace_admin(workspace_id, auth.uid())
    OR
    (
      user_id = auth.uid()
      AND NOT EXISTS (
        SELECT 1 FROM public.workspace_members wm
        WHERE wm.workspace_id = workspace_members.workspace_id
      )
    )
  );