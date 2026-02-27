

## Problem

The "No workspace selected" error occurs because the Settings page queries `workspace_members` for the current user but finds no row — the workspace is only auto-provisioned during integration setup (Gmail, Outlook, WhatsApp onboarding), never proactively. Every component that needs `workspaceId` independently runs its own lookup query, with no shared resolution or auto-creation logic.

## Root Cause

There is no centralized workspace context. At least 5 components each independently query `workspace_members.workspace_id`, and none of them auto-provision if missing. The auto-provisioning logic is copy-pasted across `ConnectInboxStep`, `WhatsAppConnectionCard`, and `OutlookConnectionCard` — but Settings doesn't have it.

## Plan

### 1. Create a `WorkspaceContext` provider

New file: `src/contexts/WorkspaceContext.tsx`

- On mount: query `workspace_members` for the current user's workspace
- If no workspace exists: auto-provision one (`INSERT workspaces` → trigger adds admin membership → return ID)
- Expose: `workspaceId`, `workspaceRole`, `isLoading`, `workspace` (name, plan)
- Wrap the app inside `AuthProvider` so it only runs when authenticated

### 2. Refactor Settings page to use `WorkspaceContext`

- Remove the local `useEffect` workspace lookup in `Settings.tsx`
- Import `useWorkspace()` and pass `workspaceId` to `CallSettingsCard` and any other workspace-scoped cards
- `CallSettingsCard` no longer shows "No workspace selected" — the context guarantees a workspace exists

### 3. Add Workspace Members management section in Settings

New component: `src/components/settings/WorkspaceMembersCard.tsx`

- List current `workspace_members` with role badges (admin/manager/rep)
- Admin-only: invite new member by email (insert into a `workspace_invitations` table or directly add via `workspace_members` + auth lookup)
- Admin-only: change member role via dropdown
- Admin-only: remove member
- Show workspace name and allow rename (admin only)

This requires a new DB table for invitations:

```sql
CREATE TABLE public.workspace_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  email text NOT NULL,
  role workspace_role NOT NULL DEFAULT 'rep',
  invited_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz
);
-- RLS: admins can CRUD, invited user can view/accept their own
```

An edge function `accept-workspace-invite` will handle the accept flow: verify the invitation belongs to the authenticated user's email, insert into `workspace_members`, update invitation status.

### 4. Auto-join workspace on login if invitation exists

In the `WorkspaceContext` provider, after checking membership:
- If no membership found, check `workspace_invitations` for the user's email with status = 'pending'
- If found, auto-accept: insert into `workspace_members` and update invitation

### 5. Wire WorkspaceContext into existing components

Replace ad-hoc workspace lookups in:
- `OutlookConnectionCard` (local `fetchWorkspaceId`)
- `WhatsAppConnectionCard` (inline auto-provision)
- `ConnectInboxStep` (inline `ensureWorkspace`)

All become: `const { workspaceId } = useWorkspace();`

### 6. Add Workspace Settings accordion section

In `Settings.tsx`, add a new top-level accordion item "Workspace & Team" above the existing sections:
- Workspace name + plan display
- Members list with role management
- Invite form

---

### Technical Detail: Files to create/edit

| Action | File |
|--------|------|
| Create | `src/contexts/WorkspaceContext.tsx` |
| Create | `src/components/settings/WorkspaceMembersCard.tsx` |
| Create | `supabase/functions/accept-workspace-invite/index.ts` |
| Migration | `workspace_invitations` table + RLS |
| Edit | `src/App.tsx` (wrap with WorkspaceProvider) |
| Edit | `src/pages/Settings.tsx` (use context, add Members section) |
| Edit | `src/components/settings/CallSettingsCard.tsx` (use context) |
| Edit | `src/components/settings/OutlookConnectionCard.tsx` (use context) |
| Edit | `src/components/settings/WhatsAppConnectionCard.tsx` (use context) |
| Edit | `src/components/onboarding/ConnectInboxStep.tsx` (use context) |

