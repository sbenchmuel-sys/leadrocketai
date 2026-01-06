-- Add owner_user_id column as nullable first
ALTER TABLE public.kb_chunks 
ADD COLUMN IF NOT EXISTS owner_user_id UUID;

-- Update existing rows: assign to a default user or leave null and handle with policy
-- For existing data, we'll make them accessible to all authenticated users via policy

-- Drop the overly permissive policies
DROP POLICY IF EXISTS "Authenticated users can delete kb_chunks" ON public.kb_chunks;
DROP POLICY IF EXISTS "Authenticated users can insert kb_chunks" ON public.kb_chunks;
DROP POLICY IF EXISTS "Authenticated users can update kb_chunks" ON public.kb_chunks;
DROP POLICY IF EXISTS "Authenticated users can view kb_chunks" ON public.kb_chunks;

-- Create properly scoped RLS policies
-- For SELECT: users see their own OR shared (null owner) OR admins see all
CREATE POLICY "Users can view their own kb_chunks or shared"
ON public.kb_chunks
FOR SELECT
USING (
  owner_user_id = auth.uid() 
  OR owner_user_id IS NULL 
  OR has_role(auth.uid(), 'admin'::app_role)
);

-- For INSERT: new entries must have owner_user_id = current user
CREATE POLICY "Users can insert their own kb_chunks"
ON public.kb_chunks
FOR INSERT
WITH CHECK (auth.uid() = owner_user_id);

-- For UPDATE: only owner or admins (not shared data unless admin)
CREATE POLICY "Users can update their own kb_chunks or admins"
ON public.kb_chunks
FOR UPDATE
USING (
  owner_user_id = auth.uid() 
  OR has_role(auth.uid(), 'admin'::app_role)
);

-- For DELETE: only owner or admins
CREATE POLICY "Users can delete their own kb_chunks or admins"
ON public.kb_chunks
FOR DELETE
USING (
  owner_user_id = auth.uid() 
  OR has_role(auth.uid(), 'admin'::app_role)
);