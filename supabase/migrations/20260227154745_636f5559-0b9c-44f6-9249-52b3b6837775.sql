
-- Workspace invitations table for team member invites
CREATE TABLE public.workspace_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role workspace_role NOT NULL DEFAULT 'rep',
  invited_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  UNIQUE(workspace_id, email)
);

-- Enable RLS
ALTER TABLE public.workspace_invitations ENABLE ROW LEVEL SECURITY;

-- Workspace admins can manage invitations
CREATE POLICY "Workspace admins can manage invitations"
  ON public.workspace_invitations
  FOR ALL
  USING (is_workspace_admin(workspace_id, auth.uid()))
  WITH CHECK (is_workspace_admin(workspace_id, auth.uid()));

-- Users can view invitations sent to their email
CREATE POLICY "Users can view their own invitations"
  ON public.workspace_invitations
  FOR SELECT
  USING (lower(email) = lower((SELECT email FROM auth.users WHERE id = auth.uid())));

-- Users can update (accept) their own pending invitations
CREATE POLICY "Users can accept their own invitations"
  ON public.workspace_invitations
  FOR UPDATE
  USING (lower(email) = lower((SELECT email FROM auth.users WHERE id = auth.uid())) AND status = 'pending');
