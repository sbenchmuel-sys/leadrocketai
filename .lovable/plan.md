

## Problem

Gmail sync runs every few minutes and recalculates lead automation fields. Its "preservation" check only protects leads where `needs_action = true AND eligible_at is in the future`. 

Nurture automation starts with `needs_action = false` (it only flips to `true` when the cadence date arrives). So gmail-sync sees nurture leads as having no active automation and overwrites their fields -- turning automation off.

## Fix

Expand the automation preservation in `gmail-sync` to also recognize nurture leads.

### 1. Fetch nurture fields in the state query (line 1279)

Change the select from:
```text
"eligible_at, needs_action"
```
to:
```text
"eligible_at, needs_action, motion, nurture_status"
```

### 2. Broaden the preservation check (lines 1283-1285)

Add a nurture-specific condition:

```text
hasActiveSequence = needs_action === true AND eligible_at > now()
hasActiveNurture  = motion === 'nurture' AND nurture_status === 'active'
hasActiveAutomation = hasActiveSequence OR hasActiveNurture
```

This ensures nurture leads keep their `needs_action`, `eligible_at`, `next_action_key`, `next_action_label`, and `action_reason_code` fields intact across sync cycles -- even when `needs_action` is currently `false`.

### Files Changed

- `supabase/functions/gmail-sync/index.ts` -- ~5 lines changed around line 1277-1285
