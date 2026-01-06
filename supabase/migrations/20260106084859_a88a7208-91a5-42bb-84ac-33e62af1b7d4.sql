-- Update orphaned kb_chunks to be owned by the first user who has a profile
UPDATE kb_chunks 
SET owner_user_id = (SELECT user_id FROM profiles LIMIT 1)
WHERE owner_user_id IS NULL;