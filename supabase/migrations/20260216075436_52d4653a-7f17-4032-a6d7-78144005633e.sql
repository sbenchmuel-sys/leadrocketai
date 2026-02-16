
-- Auto-add workspace creator as admin member via trigger
CREATE OR REPLACE FUNCTION public.auto_add_workspace_creator()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (NEW.id, auth.uid(), 'admin');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_add_workspace_creator
  AFTER INSERT ON public.workspaces
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_add_workspace_creator();
