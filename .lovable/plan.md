# Stop ghost automation queueing — root cause + permanent fix

## What actually happened

Yes — **5 more emails fired in Cliff's workspace at 09:00 UTC today (2026-04-30)** before my previous fix landed at 12:14 UTC:

| Recipient | Sent at (UTC) | Status |
|---|---|---|
| darrell.coffin@garda.com | 09:00:27 | sent |
| keith.desnayers@garda.com | 09:00:36 | sent |
| jay.waxman@clearcard.ca | 09:00:41 | sent |
| stephane.mally@garda.com | 09:00:55 | sent |
| seanm@respondnm.com | 09:01:05 | sent |

These were "send_pre_2" follow-ups that had been queued the day before. The previous consent-gate fix (`automation_mode IS NOT NULL`) was added 3 hours later — it caught **future** sends but not the queue already armed for the 9 AM window.

## The deeper bug — why leads keep showing as "in automation"

The executor consent gate is in place, BUT the queue itself is still being populated by another path:

- **`supabase/functions/_shared/syncEngine.ts`** (called every Gmail/Outlook sync) writes `eligible_at` + `needs_action=true` on leads based purely on inbound/outbound timing — **with no check on `automation_mode`**.
- It runs continuously as part of mail sync. So every lead Cliff has ever exchanged email with gets re-armed: `eligible_at` set, `needs_action` set, `next_action_key=send_pre_2` etc.
- The executor's consent gate now blocks the actual SEND, but the dashboard still shows these leads as "in automation" because the surfaced state looks identical to a real automation lead.
- Cliff is now manually clicking "stop" on each one, but the next mail sync re-queues them.

This is also what allowed today's 9 AM batch to fire: those leads were queued by syncEngine on Apr 29 (before the consent gate existed in the executor).

## Fix — three layers

### 1. Block syncEngine from arming sends without consent (the actual root cause)

In `supabase/functions/_shared/syncEngine.ts`, before returning any action that sets `eligible_at` for an outbound send (`send_pre_*`, `send_nurture_*`, `reengage`, `closing_followup`, `post_meeting_followup`, `switch_to_nurture`, `generate_post_meeting_recap`), check the lead's `automation_mode`:

- If `automation_mode IS NULL` → return a "suggestion" state: `needs_action=true` (so it surfaces in the UI as "Suggested action") but **`eligible_at=null`** (so the executor never picks it up, and the UI doesn't show it as scheduled).
- If `automation_mode` is set → keep current behavior.

This is the single chokepoint. Fix it here and the ghost queue stops.

### 2. Lock down the OOO surfacer in `automation-executor`

The OOO-return block at lines 148-190 promotes leads from `needs_action=false → true` whenever `eligible_at <= now AND ooo_until <= now`, regardless of `automation_mode`. Add the same `automation_mode IS NOT NULL` guard here so we never auto-promote a non-consented lead into the executor's main queue.

### 3. Clean up Cliff's workspace right now

Run via migration:
```sql
UPDATE leads
SET eligible_at = NULL,
    needs_action = false,
    next_action_key = NULL,
    next_action_label = NULL,
    action_reason_code = NULL
WHERE workspace_id = 'a8e1d905-297c-42f2-83cf-681f0cbf4ce5'
  AND automation_mode IS NULL;
```

Same for **every other workspace** (audit-and-clean, since this bug affected all pilot users):
```sql
UPDATE leads
SET eligible_at = NULL,
    needs_action = false,
    next_action_key = NULL,
    next_action_label = NULL,
    action_reason_code = NULL
WHERE automation_mode IS NULL
  AND eligible_at IS NOT NULL;
```

I will report the count of cleaned rows per workspace before applying.

## Why this is the last time

After this fix, **only one path** can arm a send: a user explicitly clicks "Enable Automation" in `BulkAutomationDialog` or `AutomationPreviewCard`, which sets `automation_mode='auto'`. Mail sync, OOO detection, webhooks, and cron jobs are all blocked from setting `eligible_at` on a lead without that flag.

## Files to change

- `supabase/functions/_shared/syncEngine.ts` — add `automation_mode` check before returning `eligible_at` for send actions
- `supabase/functions/automation-executor/index.ts` — add consent guard to OOO surfacer (lines 148-190)
- New migration — clean stale `eligible_at` across all workspaces

## What I will NOT do

- Touch the `reply_now` action (incoming reply pending) — that's a "you should reply" surface, not an outbound send.
- Touch nurture pre-generate or any draft-generation path — drafts are fine, sending is the issue.
- Disable Cliff's account or pause his real automation work; he can still opt-in per lead.
