
## Root cause

`outlook-callback` is failing on the DB upsert with:

```
duplicate key value violates unique constraint "mail_accounts_workspace_default_idx"
```

That index is a partial unique index over `(workspace_id) WHERE is_default = true` — only one default mail account per workspace.

In the callback, `isDefault` is computed as:

```ts
const { count: existingCount } = await serviceClient
  .from("mail_accounts")
  .select("id", { count: "exact", head: true })
  .eq("workspace_id", stateData.workspace_id)
  .eq("provider", "outlook");        // ← only counts OUTLOOK rows
const isDefault = (existingCount ?? 0) === 0;
```

It only counts existing Outlook accounts in the workspace, ignoring any existing Gmail account. The user's workspace `5a259362-…` already has Gmail `s.benchmuel@gmail.com` with `is_default = true`. When connecting Outlook for the first time, `existingCount = 0` → `isDefault = true` → the upsert tries to insert a second row with `is_default = true` in the same workspace → unique index violates → upsert returns error → callback returns "Connection Failed" → the Outlook row is never saved.

Consequences observed:
- No `mail_accounts` row for Outlook in that workspace (confirmed in DB).
- `useMailSync` keeps returning Gmail as the active provider.
- `EmailActionDialog` shows "Open in Gmail" because `activeMailProvider === "gmail"`.
- The Settings card never flips to "Connected" because `mail_accounts` has no row.

`gmail-callback` has the same shape (`is_default: true` then `update is_default = false WHERE email != current`), but in practice it survives because Gmail re-connects always hit `onConflict (workspace_id, email_address)` → UPDATE on the existing row, not a fresh INSERT, so no second `is_default = true` row is created.

## Fix

### A. `supabase/functions/outlook-callback/index.ts`

Replace the `isDefault` computation so it respects existing defaults across **all** providers in the workspace, and only promotes the new Outlook account when there is genuinely no default yet.

```ts
// Replaces lines 162–169
const { data: existingDefault } = await serviceClient
  .from("mail_accounts")
  .select("id, email_address")
  .eq("workspace_id", stateData.workspace_id)
  .eq("is_default", true)
  .maybeSingle();

// Also handle the re-connect case: if this same Outlook row is already
// the default, preserve that — the upsert path will UPDATE, not INSERT.
const isDefault =
  !existingDefault ||
  existingDefault.email_address.toLowerCase() === emailAddress.toLowerCase();
```

No other changes to the callback. Subscription creation, redirect, and logging stay the same.

### B. `supabase/functions/gmail-callback/index.ts` (defensive)

Same hazard if a workspace ever has Outlook connected first and then Gmail. Lines 224–248 unconditionally set `is_default: true` then `update is_default = false WHERE email != current`. If `gmailEmail` does not already exist as a row in `mail_accounts`, the INSERT fires before the subsequent UPDATE, hitting the same partial-unique violation.

Mirror the Outlook fix:

```ts
const { data: existingDefault } = await supabase
  .from("mail_accounts")
  .select("id, email_address")
  .eq("workspace_id", membership.workspace_id)
  .eq("is_default", true)
  .maybeSingle();

const isDefault =
  !existingDefault ||
  existingDefault.email_address.toLowerCase() === gmailEmail.toLowerCase();
```

Then pass `is_default: isDefault` into the upsert. Drop the post-upsert "clear other defaults" UPDATE (it is unsafe in general and unnecessary now — first writer wins; the user changes default explicitly in Settings).

### C. Redeploy

Deploy both edge functions: `outlook-callback` and `gmail-callback`.

### D. Verification

1. From the affected workspace, click "Connect Outlook" again and complete the OAuth dance.
2. Expected: callback returns the redirect (not the error HTML), Settings card shows the Outlook address as connected with no "Default" badge (Gmail remains default), `mail_accounts` has a new row with `is_default = false`.
3. `useMailSync.provider` still returns `gmail` (because Gmail is the default), so the composer correctly continues to show "Open in Gmail" — that is now expected.

### E. Out of scope (call out, don't ship)

- **Switching default provider from the UI**: `OutlookConnectionCard` shows a `is_default` badge but has no "Make default" button. After this fix, an Outlook user whose workspace already has Gmail will still see Gmail as primary in the composer. If the user wants the composer to say "Open in Outlook" without disconnecting Gmail, we need a small "Make default" action in Settings that flips `is_default` (and clears the other rows in a single transaction via an RPC). That is a separate feature.
- The 3 pre-existing `status = 'error'` Outlook rows in `mail_accounts` are from older workspaces and unrelated to this bug — leave them alone.

## Test plan summary

| Step | Expected |
|---|---|
| Reconnect Outlook on the affected workspace | Redirects back with `?outlook_connected=true&outlook_email=…` |
| `psql` check | New `mail_accounts` row, `provider=outlook`, `status=connected`, `is_default=false` |
| Settings card | Shows Outlook as connected |
| Edge logs for `outlook-callback` | No `callback_upsert_failed`; sees `mail.outlook.connected` |
| Composer | Still shows "Open in Gmail" until user changes the default (separate UX) |
