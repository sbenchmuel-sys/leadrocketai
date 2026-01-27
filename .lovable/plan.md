
# Fix: Dismissed Actions Reappearing After Refresh

## Problem Summary
When a user dismisses an action (e.g., "Already handled") in the Action Required panel, the lead is removed from the queue temporarily, but reappears after a page refresh.

## Root Cause Analysis
The issue stems from the `gmail-sync` Edge Function unconditionally overwriting the `needs_action` field:

1. **Dismiss flow (works correctly):** When clicking "Already handled", `dismissLeadAction()` sets:
   - `needs_action: false`
   - `next_action_key: null`
   - `action_reason_code: "already_handled"`

2. **Sync flow (overwrites dismissal):** When `gmail-sync` runs (on page load, auto-sync, or manual sync), it:
   - Recalculates `deriveAction()` based on interaction metrics
   - Blindly updates the lead with computed values (`needs_action: true`, new `action_reason_code`)
   - **Does NOT check if the action was manually dismissed**

This means the backend has no "memory" that the user already handled this specific action.

## Solution
Add an `action_dismissed_at` timestamp field to track when an action was dismissed, and modify the `gmail-sync` function to respect this dismissal until a new interaction invalidates it.

### Logic
- When user dismisses: Set `action_dismissed_at = now()`
- When sync runs: Check if `action_dismissed_at > last_outbound_at` (or any relevant interaction timestamp)
  - If true, the dismissal is still valid - don't suggest this action again
  - If false (new email sent/received since dismissal), reset and recalculate

---

## Implementation Plan

### Phase 1: Database Schema Update
Add a new column to track when an action was dismissed:

```sql
ALTER TABLE leads ADD COLUMN IF NOT EXISTS action_dismissed_at TIMESTAMP WITH TIME ZONE;
```

### Phase 2: Update Dismiss Function
**File:** `src/lib/supabaseQueries.ts`

Update `dismissLeadAction` to also set the `action_dismissed_at` timestamp:

```typescript
export async function dismissLeadAction(leadId: string, reasonCode?: string): Promise<void> {
  const { error } = await supabase
    .from('leads')
    .update({
      needs_action: false,
      next_action_key: null,
      next_action_label: null,
      action_reason_code: reasonCode || null,
      action_dismissed_at: new Date().toISOString(), // NEW
      last_activity_at: new Date().toISOString(),
    })
    .eq('id', leadId);
  if (error) throw error;
}
```

### Phase 3: Update gmail-sync to Respect Dismissals
**File:** `supabase/functions/gmail-sync/index.ts`

1. **Fetch current lead state** including `action_dismissed_at` before computing new action
2. **Add dismissal check** in the `deriveAction` function or before updating the lead:
   - If `action_dismissed_at` exists and is more recent than the latest interaction, skip overwriting
   - If a new interaction occurred after dismissal, clear `action_dismissed_at` and recalculate

Modified logic at lead update section (around line 1148):

```typescript
// Fetch current lead state to check for dismissal
const { data: currentLead } = await serviceSupabase
  .from("leads")
  .select("action_dismissed_at")
  .eq("id", leadId)
  .single();

// Check if dismissal should be respected
const dismissedAt = currentLead?.action_dismissed_at 
  ? new Date(currentLead.action_dismissed_at).getTime() 
  : 0;
const lastInteractionTime = Math.max(
  metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0,
  metrics.last_inbound_at ? new Date(metrics.last_inbound_at).getTime() : 0
);

let finalAction = actionResult;

// If dismissed after last interaction, respect the dismissal
if (dismissedAt > 0 && dismissedAt > lastInteractionTime) {
  console.log(`[gmail-sync] Lead ${leadId}: Respecting manual dismissal from ${currentLead.action_dismissed_at}`);
  finalAction = {
    needs_action: false,
    next_action_key: null,
    next_action_label: null,
    eligible_at: null,
    action_reason_code: null, // Keep existing reason code
  };
}

// If new interaction occurred after dismissal, clear the dismissal flag
const shouldClearDismissal = dismissedAt > 0 && lastInteractionTime > dismissedAt;

const leadUpdate = {
  stage,
  needs_action: finalAction.needs_action,
  next_action_key: finalAction.next_action_key,
  next_action_label: finalAction.next_action_label,
  eligible_at: finalAction.eligible_at,
  action_reason_code: finalAction.action_reason_code,
  // Clear dismissal if new interaction occurred
  action_dismissed_at: shouldClearDismissal ? null : undefined,
  // ... rest of metrics
};
```

### Phase 4: Update LeadUpdate Interface
**File:** `supabase/functions/gmail-sync/index.ts`

Add `action_dismissed_at` to the `LeadUpdate` interface:

```typescript
interface LeadUpdate {
  // ... existing fields
  action_dismissed_at?: string | null;
}
```

---

## Technical Details

### Dismissal Validity Rules
The dismissal remains valid until:
1. A new outbound email is sent by the user
2. A new inbound email is received from the lead
3. A new meeting summary is processed

Once any of these occur, the system recalculates the action as normal.

### Edge Cases Handled
- **User dismisses, then sends email:** Dismissal cleared, new action calculated
- **User dismisses, lead replies:** Dismissal cleared, "Reply to customer" action shown
- **User dismisses, no new activity:** Dismissal respected indefinitely
- **Multiple syncs in a row:** Dismissal persists across all syncs until new interaction

---

## Files to Modify

| File | Change |
|------|--------|
| Database migration | Add `action_dismissed_at` column |
| `src/lib/supabaseQueries.ts` | Update `dismissLeadAction` to set timestamp |
| `supabase/functions/gmail-sync/index.ts` | Add dismissal check before lead update |

---

## Expected Behavior After Fix

1. User clicks "Already handled" on a lead action
2. Lead is removed from Action Required panel
3. Page refresh: Lead stays removed (dismissal respected)
4. Gmail sync runs: Lead stays removed (dismissal timestamp checked)
5. User sends new email to lead: Dismissal cleared, new action may appear
6. Lead replies: Dismissal cleared, "Reply to customer" action appears
