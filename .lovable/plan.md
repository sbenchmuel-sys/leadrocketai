

# Fix: Automation Stops Before Sending Emails

## Root Causes Found

### 1. Status check rejects "new" leads (executor bug)
In `automation-executor` line 171, the safety re-check does:
```
statusInactive = freshLead.status !== "active"
```
Itai's lead has `status: "new"`, so the executor skips it with "Safety block: inactive" -- even though the initial query on line 50 correctly includes both `"active"` and `"new"` statuses.

**Fix:** Change the safety check to match the initial query: `freshLead.status !== "active" && freshLead.status !== "new"`.

### 2. Gmail sync overwrites automation scheduling (the main killer)
Every time `gmail-sync` runs (every 20 minutes via auto-sync, plus any manual sync or screen refresh), it recalculates `deriveAction()` and then **unconditionally overwrites** these fields on the lead (lines 1276-1282):
- `needs_action`
- `next_action_key`
- `next_action_label`
- `eligible_at`
- `action_reason_code`

For a new lead with no email history (like Itai), `deriveAction()` returns `needs_action: false` with everything null -- wiping the automation schedule that was set up when automation was enabled. This is why "sometimes it just stops."

**Fix:** In `gmail-sync`, before overwriting action fields, check if the lead currently has automation scheduled (a valid `eligible_at` in the future). If so, preserve the existing action fields instead of overwriting them with the recalculated values.

### 3. Manual email send clears automation (`useGmailSync.ts`)
Line 229 in `useGmailSync.ts` sets `needs_action: false` after any manual email send. If a user sends a manual email to a different lead, this is fine. But for leads with active automation, clearing `needs_action` kills the sequence.

**Fix:** Only clear `needs_action` if the lead does NOT have a future `eligible_at` set (i.e., no active automation).

---

## Changes

### File 1: `supabase/functions/automation-executor/index.ts`
- Line 171: Change `freshLead.status !== "active"` to `freshLead.status !== "active" && freshLead.status !== "new"`

### File 2: `supabase/functions/gmail-sync/index.ts`
- Lines 1275-1309: Before applying `leadUpdate`, fetch the current lead's `eligible_at` and `needs_action`. If the lead has an active automation schedule (`eligible_at` is set and in the future, and `needs_action` is true), skip overwriting the action fields (`needs_action`, `next_action_key`, `next_action_label`, `eligible_at`, `action_reason_code`). Only overwrite metrics and stage.
- Add a query before the update to check: `SELECT eligible_at, needs_action FROM leads WHERE id = leadId`

### File 3: `src/hooks/useGmailSync.ts`
- Line 226-229: Before setting `needs_action: false`, check if the lead has an active automation schedule. If `eligible_at` is set in the future, do not clear `needs_action`.
- Update the lead query on line 221 to also select `eligible_at` and `needs_action`

---

## Summary
Three bugs conspire to kill automation:
1. The executor rejects "new" status leads (immediate fix)
2. Gmail sync overwrites scheduling every 20 minutes (the main problem)
3. Manual sends clear automation flags (edge case)

After these fixes, automation scheduling will survive Gmail syncs and screen refreshes.

