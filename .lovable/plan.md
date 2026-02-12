

## Demo Reset Feature

A "Reset Demo" button that wipes all user data and restarts the onboarding flow from scratch. This is the safest approach because all data is already scoped by user ID, requiring no schema changes.

### How It Works

1. User clicks "Reset Demo" in the sidebar or settings
2. A confirmation dialog warns that all data will be permanently deleted
3. A backend function deletes all user-owned data across every table
4. The profile is reset to `onboarding_done = false`, `onboarding_step = 0`
5. The user is redirected to the onboarding flow automatically

### What Gets Deleted

All data owned by the current user:
- Leads, contacts, contact identities
- Conversations, messages, conversation analysis
- Drafts, interactions, meeting summaries, meeting packs
- Knowledge base chunks, onboarding config
- Rep profiles, rep signatures, workspace profiles
- Gmail connections, integrations, OAuth states
- Manager views and metrics
- The workspace itself and workspace membership

### Changes Required

**1. New backend function: `reset-demo`**
- Accepts authenticated requests only
- Deletes data from all user-scoped tables in dependency order (children first)
- Resets the `profiles` row: `onboarding_done = false`, `onboarding_step = 0`
- Returns success/failure

**2. Updated sidebar (`DashboardLayout.tsx`)**
- Add a "Reset Demo" button near the Sign Out button
- Wrapped in an AlertDialog for confirmation ("This will permanently erase all your data")
- On confirm: calls the `reset-demo` function, refreshes the profile (which triggers redirect to onboarding)

**3. No schema changes needed**
- All tables already use `owner_user_id` or `workspace_id` linked to the user
- No migrations required

### Technical Details

Tables to clear (in order to respect dependencies):

```text
1. conversation_analysis  (depends on conversations)
2. messages               (depends on conversations)
3. conversations          (depends on contacts)
4. contact_identities     (depends on contacts)
5. contacts
6. drafts                 (depends on leads)
7. interactions           (depends on leads)
8. meeting_packs          (depends on leads)
9. meeting_summaries      (depends on leads)
10. leads
11. kb_chunks
12. onboarding_config
13. rep_signatures
14. rep_profiles
15. workspace_profiles
16. gmail_connections
17. integrations
18. oauth_states
19. manager_conversation_metrics
20. manager_views
21. unmatched_meeting_summaries
22. workspace_members
23. workspaces
24. profiles (UPDATE only -- reset onboarding flags)
```

The edge function will use the service role key and delete by `owner_user_id = user.id` or `workspace_id IN (user's workspaces)` depending on the table's schema.

