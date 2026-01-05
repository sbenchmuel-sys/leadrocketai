-- Drop the admin-only policy
DROP POLICY IF EXISTS "Only admins can modify kb_chunks" ON kb_chunks;

-- Allow all authenticated users to insert knowledge snippets
CREATE POLICY "Authenticated users can insert kb_chunks"
ON kb_chunks FOR INSERT
TO authenticated
WITH CHECK (true);

-- Allow all authenticated users to update knowledge snippets
CREATE POLICY "Authenticated users can update kb_chunks"
ON kb_chunks FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

-- Allow all authenticated users to delete knowledge snippets
CREATE POLICY "Authenticated users can delete kb_chunks"
ON kb_chunks FOR DELETE
TO authenticated
USING (true);