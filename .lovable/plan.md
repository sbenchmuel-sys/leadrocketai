

# Fix: Strategy Switch from Nurture to Fast Not Resetting State

## Problem
When switching a lead from **Nurture back to Fast** mode via the mode toggle in the LeadTable, only `strategy` and `nurture_cadence` are updated. All nurture-related fields persist:
- `motion` stays as `"nurture"` (so the Phase badge still shows "Nurture")
- `next_action_key` stays as `"send_nurture_1"` 
- `next_action_label` stays as `"Review first nurture email"`
- `nurture_status`, `nurture_mode`, `nurture_theme` all persist
- `needs_action` stays true for the wrong reason

This is because `NurtureSwitchDialog` sets ~10 fields when activating nurture, but `handleStrategyToggle` only resets 2 of them when reverting.

## Root Cause
In `src/components/dashboard/LeadTable.tsx`, lines 190-197, the nurture-to-fast update is:
```
strategy: "fast",
nurture_cadence: null,
mode_changed_at: new Date().toISOString(),
```

It needs to also reset motion, nurture fields, and re-derive the correct next action.

## Fix

### File: `src/components/dashboard/LeadTable.tsx`

Update the `handleStrategyToggle` function (the nurture-to-fast branch) to reset all nurture-related fields:

```typescript
const { error } = await supabase
  .from("leads")
  .update({
    strategy: "fast",
    // Reset nurture-specific fields
    nurture_cadence: null,
    nurture_mode: null,
    nurture_status: null,
    nurture_theme: null,
    auto_nurture_eligible: false,
    // Restore motion based on lead context
    motion: lead.last_inbound_at ? "inbound_response" : "outbound_prospecting",
    // Clear nurture-driven action
    needs_action: false,
    next_action_key: null,
    next_action_label: null,
    action_reason_code: null,
    mode_changed_at: new Date().toISOString(),
  })
  .eq("id", lead.id);
```

This mirrors the inverse of what `NurtureSwitchDialog.handleConfirm` sets, ensuring a clean state transition back to Fast mode.

## What Changes
- Phase badge reverts from "Nurture" to the correct phase (e.g., "Prospecting" for new leads)
- Motion resets to `outbound_prospecting` or `inbound_response` based on lead history
- Next Action clears the stale "Review first nurture email" label
- All nurture metadata (`nurture_mode`, `nurture_status`, `nurture_theme`) is cleared

## Files Modified
1. **`src/components/dashboard/LeadTable.tsx`** -- Expand the nurture-to-fast update object to reset all nurture-related fields

