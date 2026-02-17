
# Fix: Gmail Sync Overwriting Nurture Leads with Prospecting Actions

## Root Cause

There are **two sync functions** that run periodically and overwrite nurture lead state:

### 1. `gmail-bulk-sync` (Primary Culprit)
This function has **zero protection** for nurture leads. When it syncs emails for a lead, it:
- Calls `deriveAction()` which doesn't check the lead's `motion` field
- Blindly overwrites `needs_action`, `next_action_key`, `next_action_label` with prospecting follow-up actions (e.g., `send_pre_2`, `send_pre_3`)
- This triggers the automation-executor to send outbound prospecting emails instead of nurture emails

### 2. `gmail-sync` (Secondary Issue)
This function has a `hasActiveAutomation` guard, but it only works when `needs_action` is already `true` AND `eligible_at` is in the future. For nurture leads in "review" mode (where `needs_action` is `false`), the guard doesn't activate, and `deriveAction` can still overwrite action keys with prospecting follow-ups.

## Changes

### 1. Protect Nurture Leads in `gmail-bulk-sync/index.ts`

Before the `leads.update` call (line 578-592), add a check for the lead's current motion and nurture status. If the lead is in nurture mode, preserve its automation fields:

- Fetch current `motion`, `nurture_status`, `needs_action`, `eligible_at` before updating
- If `motion === "nurture" && nurture_status === "active"`, skip overwriting `needs_action`, `next_action_key`, `next_action_label`
- Still update metrics fields like `first_outbound_at`, `last_outbound_at`, `last_inbound_at`, `meeting_summary_count`, `last_activity_at`

### 2. Strengthen Nurture Guard in `gmail-sync/index.ts`

Update the `hasActiveAutomation` check (lines 1283-1290) to also protect nurture leads even when `needs_action` is false:

Current logic:
```text
hasActiveSequence = needs_action === true && eligible_at > now
hasActiveNurture = motion === "nurture" && nurture_status === "active"
hasActiveAutomation = hasActiveSequence || hasActiveNurture
```

The `hasActiveNurture` check is correct but the protection on lines 1296-1300 only conditionally preserves fields. Ensure that when `hasActiveNurture` is true, the `next_action_key` and `next_action_label` are explicitly preserved (not set to `undefined` which would leave existing values, but currently the `finalAction` values can still leak through if the conditional logic has edge cases).

Additionally, add a dedicated guard in `deriveAction()` itself:
- Accept the lead's `motion` as a parameter
- If `motion === "nurture"`, skip sections C (outbound follow-up) and return early with nurture-appropriate action or no action

### 3. Protect `eligible_at` in `gmail-bulk-sync`

Currently `gmail-bulk-sync` doesn't update `eligible_at`, but it overwrites `needs_action` which can desync with the existing `eligible_at` value on nurture leads.

## Files Modified

- `supabase/functions/gmail-bulk-sync/index.ts` -- Add nurture lead protection before update
- `supabase/functions/gmail-sync/index.ts` -- Strengthen nurture guard in deriveAction and update logic

## Technical Details

### gmail-bulk-sync Fix (lines 564-592)

Before the update block, fetch the lead's current state:

```text
// Fetch current lead state to protect nurture leads
const { data: currentState } = await serviceSupabase
  .from("leads")
  .select("motion, nurture_status, needs_action, eligible_at, next_action_key, next_action_label, action_reason_code")
  .eq("id", leadId)
  .single();

const isActiveNurture = currentState?.motion === "nurture" 
  && currentState?.nurture_status === "active";

const updatePayload: Record<string, unknown> = {
  stage: newStage,
  first_outbound_at: metrics.first_outbound_at,
  last_outbound_at: metrics.last_outbound_at,
  last_inbound_at: metrics.last_inbound_at,
  meeting_summary_count: metrics.meeting_summary_count,
  last_activity_at: lastActivityAt,
};

if (isActiveNurture) {
  // Preserve nurture automation fields -- don't overwrite with prospecting actions
  console.log(`[gmail-bulk-sync] Preserving nurture state for lead ${leadId}`);
} else {
  // Apply derived action for non-nurture leads
  updatePayload.needs_action = actionResult.needs_action;
  updatePayload.next_action_key = actionResult.next_action_key;
  updatePayload.next_action_label = actionResult.next_action_label;
}
```

### gmail-sync Fix (lines 1293-1308)

Ensure the nurture protection covers all action fields, and also add a motion parameter to `deriveAction` to skip outbound follow-up logic for nurture leads:

```text
// In deriveAction function signature, add motion parameter:
function deriveAction(
  leadId, metrics, nurtureCadence, stage,
  ...,
  motion: string  // <-- new parameter
)

// At the start of section C (outbound follow-ups, line 640):
if (motion === "nurture") {
  // Skip outbound follow-up logic for nurture leads
  // Fall through to section E (nurture cadence) instead
}
```

And in the update block (lines 1293-1308), when `hasActiveNurture` is true, explicitly preserve all automation fields:

```text
if (hasActiveNurture) {
  // For active nurture leads, preserve ALL automation/nurture fields
  delete leadUpdate.needs_action;  // or set to currentLeadState value
  delete leadUpdate.next_action_key;
  delete leadUpdate.next_action_label;
  delete leadUpdate.eligible_at;
  delete leadUpdate.action_reason_code;
}
```

## What This Prevents

- Nurture leads will no longer have their action keys overwritten to `send_pre_2/3/4` by background syncs
- The automation-executor will only receive nurture-appropriate tasks for nurture leads
- Metrics (outbound timestamps, counts) still update correctly even for protected nurture leads
