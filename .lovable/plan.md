## Outlook ↔ Gmail Feature Parity Implementation

Closes the two biggest gaps from the audit so Outlook users get the same multi-lead sync and onboarding flow as Gmail users.

### What gets built

**1. New edge function: `outlook-bulk-sync`**
- Mirror of `gmail-bulk-sync` but for Microsoft Graph
- Input: `{ leadIds: string[], maxResults?: number, mail_account_id?: string }`
- Resolves the user's workspace → finds the connected Outlook `mail_accounts` row → gets a fresh token via existing `getFreshOutlookToken` middleware
- For each lead, runs the exact same pipeline as `outlook-sync` (the per-lead function already implements all safeguards: direction filter, bounce, OOO, defer, meeting confirmation, unsubscribe, milestones, stage/action derivation)
- Updates `mail_accounts.last_sync_at` after the run
- Returns `{ ok, totalSynced, leadsProcessed, results, errors, needsReconnect? }` — same shape as `gmail-bulk-sync` so the UI can stay generic
- Registered in `supabase/config.toml` with `verify_jwt = false` (consistent with `outlook-sync`)
- Refactor: extract the per-lead pipeline currently in `outlook-sync/index.ts` into a small shared helper so both functions call the same code (avoids drift)

**2. UI wiring on `src/pages/Leads.tsx`**
- Use `useMailSync` to detect the active provider instead of hard-coding Gmail
- Bulk "Sync" button label becomes provider-aware: "Sync Gmail (N)" or "Sync Outlook (N)"
- Routes the call to `gmail-bulk-sync` or `outlook-bulk-sync` based on provider
- Reconnect prompt routes to `/settings` for Outlook, OAuth flow for Gmail (same pattern as `GmailSyncButton`)
- Disabled-state copy: "Connect Gmail or Outlook first"

**3. Onboarding parity check**
- `ConnectInboxStep` already exposes both Gmail and Outlook cards — no change needed there
- Verified: `OutlookConnectButton` + `outlook-health` polling already wired

### Technical details

```text
src/pages/Leads.tsx
  └─ replaces useGmailConnection with useMailSync
  └─ handleBulkSync → invokes outlook-bulk-sync when provider === "outlook"

supabase/functions/outlook-bulk-sync/index.ts   [NEW]
  ├─ auth + workspace resolution
  ├─ fetch mail_accounts row (provider=outlook, status=connected)
  ├─ getFreshOutlookToken(accountId)
  ├─ for each lead: runOutlookLeadSync(...)  ← shared helper
  └─ update mail_accounts.last_sync_at

supabase/functions/_shared/outlookLeadSync.ts   [NEW]
  └─ extracted per-lead Graph fetch + safeguards pipeline
     (currently inline in outlook-sync/index.ts)

supabase/functions/outlook-sync/index.ts
  └─ refactored to call the shared helper (no behavior change)

supabase/config.toml
  └─ [functions.outlook-bulk-sync]  verify_jwt = false
```

### Testing

After deploy:
1. Connect an Outlook account (or use Cliff's existing connection)
2. On `/app/leads`, select 2–3 leads, click "Sync Outlook (N)"
3. Tail `outlook-bulk-sync` logs to confirm: messages found, interactions created, `last_sync_at` updated
4. Verify lead timeline shows historical Outlook emails
5. Verify Gmail bulk sync still works for Gmail users (no regression)

### Out of scope

- Cron-based Outlook polling (Graph webhooks already deliver real-time push, so a cron isn't strictly needed; can add later if push fails)
- Microsoft Entra app audience update for personal `@hotmail`/`@outlook` accounts — that's a configuration task for you in the Azure portal, not a code change
