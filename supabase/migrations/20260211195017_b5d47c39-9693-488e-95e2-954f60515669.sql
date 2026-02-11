
-- Fix: restrict workspace creation to authenticated users only (not true for all)
DROP POLICY "Authenticated users can create workspaces" ON public.workspaces;

CREATE POLICY "Authenticated users can create workspaces"
  ON public.workspaces FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);
