

# Fix Nurture Automation + Bulk Nurture

## Problem

Three things are broken for nurture leads:

1. **BulkAutomationDialog rejects nurture leads** -- Line 59 in `BulkAutomationDialog.tsx` only allows `outbound_prospecting` and `inbound_response`, flagging all nurture leads as "Not eligible (Nurture)".

2. **AutomationPreviewCard hides for nurture leads** -- Line 114 checks `motion === "outbound_prospecting" || motion === "inbound_response"`, so the card never renders for nurture leads. The NurturePreviewCard exists separately but doesn't integrate with the automation scheduling system.

3. **No bulk "Move to Nurture" action** -- Users can change source in bulk but cannot switch leads to nurture mode in bulk from the dashboard.

## Changes

### File 1: `src/components/dashboard/BulkAutomationDialog.tsx`

**Line 59** -- Add `nurture` to the eligible motions check:
```
} else if (lead.motion !== "outbound_prospecting" && lead.motion !== "inbound_response" && lead.motion !== "nurture") {
```

**`computeAutomationFields` function** -- Add nurture-specific scheduling. When motion is `nurture`, use the nurture cadence (7/14/30 days) instead of the outbound/inbound sequence intervals. Set `action_reason_code` to `"NURTURE_DUE"` and also set `nurture_status: "active"` and `nurture_mode: "review"` (if not already set).

### File 2: `src/components/lead/AutomationPreviewCard.tsx`

**Line 89** -- Remove the blocker for nurture motion (`"Motion changed"` should not flag nurture).

**Line 114** -- Add nurture to the eligible check:
```
const isEligible = (motion === "outbound_prospecting" || motion === "inbound_response" || motion === "nurture") &&
  stage !== "closed_won" && stage !== "closed_lost";
```

**Nurture-specific scheduling** -- When enabling/resuming automation for nurture leads, use the nurture cadence days (from `getNurtureCadenceDays`) instead of the outbound interval array. Set step labels to nurture-specific ones (e.g., "Nurture Email 1").

### File 3: `src/components/dashboard/LeadTable.tsx`

**After the "Enable Automation" button (line 549)** -- Add a "Move to Nurture" bulk action button. When clicked, it updates all selected leads to `motion: "nurture"`, `nurture_status: "active"`, `nurture_mode: "review"`, `nurture_cadence: "biweekly"`, and schedules the first nurture email (sets `needs_action: true`, `eligible_at` based on cadence). This gives users a one-click way to bulk-move leads into nurture mode.

### File 4: `supabase/functions/automation-executor/index.ts`

Verify that the executor already handles nurture motion correctly (line 170 already includes `nurture` in the allowed motions check). The nurture-specific AI task generation should use `nurture_email_single` intent. No changes expected here -- just verification.

---

## Summary

| What | Fix |
|------|-----|
| Nurture leads flagged "Not eligible" in bulk dialog | Add `nurture` to eligible motions in `BulkAutomationDialog` |
| Automation card hidden for nurture leads | Add `nurture` to eligible check in `AutomationPreviewCard` |
| No way to bulk-move leads to nurture | Add "Move to Nurture" button in `LeadTable` bulk actions |
| Nurture scheduling uses wrong intervals | Use cadence-based scheduling (7/14/30 days) instead of sequence intervals |

