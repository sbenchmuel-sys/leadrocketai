

# Migrate Data from Gmail Account to Work Account

## What This Does
Moves all your leads, knowledge base entries, settings, and Gmail connection from the `s.benchmuel@gmail.com` account to your `shai.benchmuel@binah.ai` account so everything is accessible under one login.

## Steps

### 1. Reassign leads (111 records)
Update all leads so they belong to your work account.

### 2. Reassign knowledge base chunks (9 records)
Move the 9 KB entries from the old account to the new one (your work account already has 83 -- these 9 will be added).

### 3. Merge rep profile and workspace profile
Your work account doesn't have a rep_profile or workspace_profile yet, so we'll reassign the existing ones from the old account.

### 4. Reassign Gmail connection
Move the Gmail integration link to the new account so email sync continues working.

### 5. Clean up the old account's profile
The old profile record remains but will have no associated data. Optionally we can leave it as-is (harmless).

## Technical Details

All changes are simple `UPDATE` statements run against the database:

```sql
-- 1. Leads
UPDATE leads SET owner_user_id = 'ce2cd3db-...' WHERE owner_user_id = 'aca893f9-...';

-- 2. KB chunks
UPDATE kb_chunks SET owner_user_id = 'ce2cd3db-...' WHERE owner_user_id = 'aca893f9-...';

-- 3. Rep profile (reassign)
UPDATE rep_profiles SET user_id = 'ce2cd3db-...' WHERE user_id = 'aca893f9-...';

-- 4. Workspace profile (reassign)
UPDATE workspace_profiles SET user_id = 'ce2cd3db-...' WHERE user_id = 'aca893f9-...';

-- 5. Gmail connection
UPDATE gmail_connections SET user_id = 'ce2cd3db-...' WHERE user_id = 'aca893f9-...';
```

No code changes are needed -- this is purely a data migration. After running these updates, logging in with Google (shai.benchmuel@binah.ai) will show all 111 leads and associated data.

