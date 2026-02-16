

## Problem

When connecting WhatsApp (or any integration that triggers auto-workspace creation), the app:
1. Successfully creates a new workspace (RLS allows authenticated inserts)
2. Fails to insert the user as a workspace member because the RLS INSERT policy on `workspace_members` has a bug

The policy intended to allow the "first member" of a new workspace to insert themselves, but the subquery compares `workspace_members_1.workspace_id = workspace_members_1.workspace_id` (column vs itself -- always true), so `NOT EXISTS` is always false. Since the user also isn't an admin yet, the entire policy evaluates to false and the insert is denied.

## Fix

**Database migration** -- Fix the `workspace_members` INSERT policy:

Replace the broken policy with one that correctly checks whether the user is either:
- An existing admin of the workspace, OR
- Inserting themselves as the first member of a workspace that has no members yet, AND the `user_id` matches `auth.uid()`

```sql
DROP POLICY "Admins can insert workspace members" ON public.workspace_members;

CREATE POLICY "Admins or first member can insert workspace members"
  ON public.workspace_members
  FOR INSERT
  WITH CHECK (
    -- Existing admin can add members
    is_workspace_admin(workspace_id, auth.uid())
    OR
    -- First member: no existing members for this workspace, and inserting yourself
    (
      user_id = auth.uid()
      AND NOT EXISTS (
        SELECT 1 FROM public.workspace_members wm
        WHERE wm.workspace_id = workspace_members.workspace_id
      )
    )
  );
```

No frontend code changes are needed -- the `WhatsAppConnectionCard.tsx` logic is already correct.

