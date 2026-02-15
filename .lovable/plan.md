

# Automation Fixes + 2 Improvements (Activity Feed + Unsubscribe Handling)

This plan covers all 5 original issues plus the 2 requested improvements.

## What's Being Fixed

### Issue 1: "Automation Running" filter shows wrong results
The dashboard filter only checks nurture-auto leads, missing outbound/inbound sequence automation.

### Issue 2: No "Stop Automation" for replied leads
Currently only Pause/Resume exists. When a lead replies, users need a permanent "Stop" action.

### Issue 3: Emails not sending + no visibility
The `automation-executor` function is never triggered (no cron/scheduler). No execution log exists.

### Issue 4: Nurture timing not visible in lead card
Already partially working -- the NurturePreviewCard shows dates. Will ensure it's consistent with outbound card.

### Issue 5: Emails logged incorrectly
Automated emails are logged as `system_note` instead of `email_outbound`, making them invisible in timelines/inbox.

### Improvement 1: Automation Activity Feed in Timeline
Show automation events (sent, skipped, failed) in the lead's timeline so users can see what the system did.

### Improvement 4: Unsubscribe Handling
When a lead replies with "unsubscribe", auto-stop the sequence, flag the lead, and log it.

---

## Technical Plan

### Step 1: Database Migration — `automation_log` table
Create a new table to track every automation execution attempt:

```text
automation_log:
  id (uuid, PK)
  lead_id (uuid, FK -> leads)
  owner_user_id (uuid)
  action_key (text)
  ai_task (text)
  status (text: pending, sent, failed, skipped)
  error_message (text, nullable)
  gmail_message_id (text, nullable)
  subject (text, nullable)
  created_at (timestamptz)
  completed_at (timestamptz, nullable)
```

Add `unsubscribed` boolean column to `leads` table (default false).
RLS: users can SELECT their own leads' logs.

### Step 2: Fix `automation-executor` edge function
- Change interaction logging from `type: "system_note"` to `type: "email_outbound"` with `source: "automation"` so auto-sent emails appear in timeline and inbox
- Insert `automation_log` entries for every attempt (sent, failed, skipped) with error details
- Add retry logic: on gmail-send failure, re-queue `eligible_at` + 15 minutes (max 2 retries via log count check)
- Detect unsubscribe replies: before sending, check if last inbound contains "unsubscribe" -- if so, set `leads.unsubscribed = true`, clear automation, skip lead
- Include `gmail_message_id` from send response in the interaction record

### Step 3: Create `automation-check` edge function
A user-authenticated wrapper that:
- Accepts user auth token (not service-role only)
- Finds the current user's leads where `eligible_at <= now` and `needs_action = true`
- Runs the same execution logic inline (or calls automation-executor with service role)
- Returns results so the frontend knows what happened

Add to `config.toml`: `[functions.automation-check] verify_jwt = false`

### Step 4: Create `useAutomationPoller` hook
A frontend hook used on the Dashboard that:
- Polls `automation-check` every 60 seconds while the tab is active
- Shows a toast when an email is auto-sent ("Auto-sent Follow-up 1 to John")
- Triggers a dashboard metrics refresh after any successful send
- Pauses polling when tab is hidden (Page Visibility API)

### Step 5: Fix Dashboard "Automation Running" filter
In `src/pages/Dashboard.tsx` line 213, update the filter to match both sequence and nurture automation:

```typescript
result = result.filter((l) => {
  const hasSequenceAutomation = !!(l as any).eligible_at && l.needs_action;
  const hasNurtureAutomation = l.nurture_mode === "auto" && l.nurture_status === "active";
  return hasSequenceAutomation || hasNurtureAutomation;
});
```

### Step 6: Add "Stop Sequence" to AutomationPreviewCard
When `safetyPaused` is true (lead replied or meeting scheduled):
- Replace "Resume" with "Stop Sequence" button
- Stop clears all automation fields permanently: `next_action_key`, `next_action_label`, `eligible_at`, `needs_action`, `action_reason_code` all set to null/false
- Keep "Resume" only when `userPaused` (no safety blockers)
- Show distinct UI: red "Stop" vs amber "Resume"

### Step 7: Automation Activity Feed in Timeline
Update `TimelineTab.tsx` to:
- Add a new filter option: "Automation" alongside All/Emails/WhatsApp/Meetings/Notes
- Show automation interactions (type `email_outbound` + source `automation`) with a special "Auto-sent" badge
- Also fetch from `automation_log` for failed/skipped entries and display them as system events with status indicators (green check for sent, red X for failed, grey skip for skipped)

### Step 8: Unsubscribe Detection in `gmail-sync`
When processing inbound emails in `gmail-sync`, check if the body contains "unsubscribe" (case-insensitive, whole word):
- If detected and `stop_on_unsubscribe` is true:
  - Set `leads.unsubscribed = true`
  - Clear all automation fields (`needs_action`, `eligible_at`, `next_action_key`, etc.)
  - Set `nurture_status = "inactive"` if in nurture mode
  - Log an interaction: `type: "system_note"`, body: "Lead requested to unsubscribe"
- In `AutomationPreviewCard`, if `lead.unsubscribed === true`, show "Unsubscribed" status and prevent re-enabling automation

---

## Files to Create/Modify

| File | Action |
|------|--------|
| Database migration | Create `automation_log` table + add `unsubscribed` to `leads` |
| `supabase/functions/automation-executor/index.ts` | Fix interaction type, add logging, retry, unsubscribe check |
| `supabase/functions/automation-check/index.ts` | **New** -- user-auth wrapper for polling |
| `supabase/config.toml` | Add automation-check entry |
| `src/hooks/useAutomationPoller.ts` | **New** -- 60s polling hook with toast |
| `src/pages/Dashboard.tsx` | Fix automation filter (line 213), wire poller |
| `src/components/lead/AutomationPreviewCard.tsx` | Add Stop button, unsubscribed state |
| `src/components/lead/TimelineTab.tsx` | Add Automation filter, show auto-sent badge + log entries |
| `supabase/functions/gmail-sync/index.ts` | Add unsubscribe detection on inbound emails |

