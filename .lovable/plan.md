## Problem

The lead header shows "Connect inbox" even when Outlook is connected. Two causes:

1. **Loading flash**: `useMailSync` exposes `isConnected` but `LeadDetail` uses it without checking `isLoading`. While the mail account query is in flight, `isConnected === false`, so the fallback "Connect inbox" button renders for a moment (and persists if the query is slow or stale).
2. **Possibly stale state**: After the recent migration that promoted Outlook to default, the page needs `useMailSync` to refetch to pick it up.

## Fix

**1. `src/pages/LeadDetail.tsx`** — pull `isLoading` from `useMailSync` and pass it down.
   ```ts
   const { isConnected, isLoading: isMailLoading } = useMailSync();
   …
   isConnected={isConnected}
   isMailLoading={isMailLoading}
   ```

**2. `src/components/lead/LeadDetailHeader.tsx`** — accept `isMailLoading` and render a neutral, non-clickable placeholder while loading instead of "Connect inbox":
   ```tsx
   {isMailLoading ? (
     <Button variant="outline" size="sm" disabled className="h-8 text-xs">
       <Mail className="h-3.5 w-3.5 mr-1.5 animate-pulse" />Inbox…
     </Button>
   ) : isConnected ? (
     <MailSyncButton … />
   ) : (
     <Button asChild …>Connect inbox</Button>
   )}
   ```

**3. Audit other call sites** that branch on `isConnected` (composer "Open in Gmail/Outlook" label, drafts tab) — make sure each one also gates on `isLoading` so the wrong provider/label never flashes. Search: `rg "useMailSync\|useGmailSync" src`.

## Out of scope

- No backend or schema changes — Outlook is already correctly stored as the default account after the prior migration.
- No change to the actual data fetching logic in `useMailSync` (it already filters out orphan rows via `user_id IS NOT NULL`).

## Verification

- Hard refresh `/app/leads/:id` while logged in to the affected workspace → header should show the sync button (Outlook), never "Connect inbox".
- Briefly throttle network in DevTools → header should show the loading placeholder, then resolve to the sync button.
- Disconnect both accounts in Settings → header should correctly show "Connect inbox".