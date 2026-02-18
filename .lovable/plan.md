
# Fix: Stop Sending on Failure + Fix Remaining Nurture → Prospecting Switches

## What Happened Yesterday (Root Cause Analysis)

Looking at the automation logs, three separate bugs combined to cause the spam:

### Bug 1: The "Infinite Retry" Loop (No Send Limit)
The retry guard only counts **failed** log entries:
```
.eq("status", "failed")
```
But yesterday, all 9+ emails to Naveen and 8+ to Ansh showed **status: "sent"** — meaning Gmail accepted the send. The address was undeliverable at the recipient's mail server (bounce), but Gmail's API returned success. Since no `failed` logs were recorded, the retry guard **never fired**. Every 60 seconds the poller triggered another send.

### Bug 2: Post-Send Loop — `eligible_at` Set Too Soon
After each successful send, `automation-executor` sets `eligible_at` to the next date (e.g., March 3). But a gmail-sync or gmail-bulk-sync running in between can **overwrite `needs_action` and `eligible_at`** for leads that don't yet have the nurture protection correctly applied — resetting the timer and making the lead immediately eligible again.

### Bug 3: The `gmail-send` Background Task Overwrites Automation State
After every send (automated or manual), `gmail-send` fires a background task that calls `ai_task/analyze_outgoing_email` and then **unconditionally overwrites** the lead's `next_action_key`, `next_action_label`, and `needs_action` with what the AI suggests (lines 298-309). This can reset a just-scheduled `eligible_at` nurture step back to a prospecting key.

### Bug 4: Nurture Leads Still Getting Prospecting Action Keys
The DB query confirms: several active nurture leads still have `next_action_key: NULL` and `needs_action: false` with `eligible_at` set — meaning the automation-executor will pick them up but has no `actionKey`, fall through to the no-key path, and send `nurture_email_single`. This part is now working. BUT some still have `send_pre_*` keys from stale data that wasn't caught in the last cleanup.

---

## Fixes Required

### Fix 1: Add a Per-Lead Send Limit Guard (Critical — stops the spam)

In `automation-executor`, replace the retry check that only counts `failed` records with a check that counts **total sends** for the same lead+action within the last 24 hours:

```
// BEFORE: only counts 'failed' — useless since Gmail returns success on undeliverable
.eq("status", "failed")

// AFTER: count total 'sent' records in the last 24 hours
// If we've already sent to this lead today for this action, stop
```

Also add a hard **daily per-lead cap** of 1 automated email per lead per day (regardless of action key). This is the safety net that prevents the loop even if other bugs exist.

### Fix 2: Fix the `gmail-send` Background Task Overwriting Automation State

In `gmail-send/index.ts`, the background AI analysis (lines 270-309) **must not overwrite automation fields** when the send was triggered by automation (i.e., when called from `automation-executor`). The executor already does the post-send state update correctly.

Add a parameter `skipStateUpdate: true` that automation sends pass in, and in the background task, skip the lead state update when this flag is present.

### Fix 3: Detect Bounces / Undeliverable in Gmail Sync and Stop Automation

When `gmail-sync` or `gmail-bulk-sync` processes a lead's inbox, check for bounce-back messages (subject patterns like "Delivery Status Notification", "Undeliverable:", sender from "postmaster" or "mailer-daemon"). If a bounce is detected for a lead:
- Set `unsubscribed = true` (stops all future automation)
- Set `needs_action = false`, `eligible_at = null`
- Log a system note to the lead's timeline explaining the bounce

### Fix 4: Database Cleanup — Fix Remaining Stale Nurture Leads

A SQL update to fix all active nurture leads that currently have `send_pre_*` action keys (still stale from before the previous fixes):

```sql
UPDATE leads 
SET next_action_key = 'send_nurture_1', 
    next_action_label = 'Nurture email #1'
WHERE motion = 'nurture' 
  AND nurture_status = 'active' 
  AND next_action_key LIKE 'send_pre_%';
```

---

## Files Modified

- `supabase/functions/automation-executor/index.ts` — Fix 1: replace retry guard with daily send cap
- `supabase/functions/gmail-send/index.ts` — Fix 2: skip background state update for automation sends
- `supabase/functions/gmail-sync/index.ts` — Fix 3: detect bounce-back emails and stop automation
- `supabase/functions/gmail-bulk-sync/index.ts` — Fix 3: same bounce detection
- Database migration — Fix 4: clean up remaining stale nurture leads

## Technical Detail: The Daily Cap Logic

```text
// New guard in automation-executor (replaces the failed-only retry check):

// 1. Max 1 automated send per lead per day
const todayStart = new Date();
todayStart.setHours(0, 0, 0, 0);

const { count: todaySentCount } = await supabase
  .from("automation_log")
  .select("id", { count: "exact", head: true })
  .eq("lead_id", lead.id)
  .eq("status", "sent")
  .gte("created_at", todayStart.toISOString());

if ((todaySentCount || 0) >= 1) {
  // Already sent to this lead today — skip and push eligible_at to tomorrow
  logEntry.status = "skipped";
  logEntry.error_message = "Daily send limit reached (1 per lead per day)";
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 30, 0, 0);
  await supabase.from("leads").update({ eligible_at: tomorrow.toISOString() }).eq("id", lead.id);
  skipped++;
  continue;
}

// 2. Also keep the action-level guard but check SENT not FAILED
const { count: actionSentCount } = await supabase
  .from("automation_log")
  .select("id", { count: "exact", head: true })
  .eq("lead_id", lead.id)
  .eq("action_key", actionKey)
  .eq("status", "sent");

if ((actionSentCount || 0) >= 1) {
  // This specific action was already successfully sent — advance to next step
  // Don't re-send; the post-send update should have already scheduled next
  logEntry.status = "skipped";
  logEntry.error_message = "Action already sent — skipping duplicate";
  await supabase.from("leads").update({ needs_action: false, eligible_at: null }).eq("id", lead.id);
  skipped++;
  continue;
}
```

## What This Prevents Going Forward

- A lead can receive at most 1 automated email per day, even if bugs reset `eligible_at`
- A specific action (e.g., `send_nurture_1`) will never be sent twice to the same lead
- Bounce-back emails detected in Gmail sync will permanently stop automation for that lead
- `gmail-send` background AI analysis will no longer overwrite automation scheduling
- Remaining stale nurture leads will be corrected immediately
