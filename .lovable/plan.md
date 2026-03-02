

## Problem

The dismiss button sets `needs_action = false` and `action_dismissed_at`, but `classifyRevenueState` re-classifies the lead as `action_required` based on the unreplied-inbound check (line 204: `last_inbound_at > last_outbound_at`). The dismissal flag is completely ignored.

Additionally, the current dismiss flow only has reason codes (already handled, not relevant, etc.) but no time-based snooze. The user wants 1d, 3d, 7d snooze options that automatically resurface.

## Fix Plan

### 1. Replace reason-based dismiss with time-based snooze in `dismissLeadAction`

Update `supabaseQueries.ts` to accept a `snoozeDays` parameter instead of (or alongside) `reasonCode`. Set `action_dismissed_at = now()` and a new concept: store the snooze-until timestamp. We'll repurpose `action_dismissed_at` as the snooze-until date (simpler than adding a new column).

```typescript
// dismissLeadAction(leadId, snoozeDays)
// action_dismissed_at = now + snoozeDays
```

### 2. Respect `action_dismissed_at` in `classifyRevenueState`

In `dashboardUtils.ts`, before the unreplied-inbound check (line 200-208), add a guard:

```
if action_dismissed_at exists AND action_dismissed_at > now → skip action_required
```

This makes the dismissed_at field act as a "snoozed until" timestamp.

### 3. Update the dismiss UI in `PriorityActions.tsx`

Replace the current reason-code dropdown with snooze duration options:
- Dismiss for 1 day
- Dismiss for 3 days
- Dismiss for 7 days

Pass `snoozeDays` to `dismissLeadAction` instead of reason codes.

### Files to change

- **`src/lib/supabaseQueries.ts`** — Update `dismissLeadAction` to accept `snoozeDays: number` and set `action_dismissed_at` to `now + snoozeDays`.
- **`src/lib/dashboardUtils.ts`** — Add snooze guard in `classifyRevenueState`: if `action_dismissed_at` is in the future, skip `action_required`.
- **`src/components/dashboard/PriorityActions.tsx`** — Replace dismiss reasons with snooze durations (1d, 3d, 7d). Update `handleDismiss` to pass days.
- **`src/components/dashboard/ActionRequiredPanel.tsx`** — Same dismiss UI update if it also has the dismiss dropdown.

