

## Bulk Automation from the Dashboard

### What it does
Adds a "Enable Automation" bulk action button in the LeadTable toolbar (visible when leads are selected). Clicking it opens a confirmation dialog that:

1. Lists all selected leads with clear status flags for ones that **cannot** be automated safely
2. Flags leads that have **already replied** (have `last_inbound_at`) with a warning icon
3. Flags leads **not in an eligible motion** (not `outbound_prospecting` or `inbound_response`) -- e.g., nurture, post_meeting, closing, closed
4. Allows the user to deselect flagged leads before confirming
5. On confirm, enables automation on all eligible (non-flagged) leads in one batch

### UI Flow

1. User selects multiple leads via checkboxes
2. Bulk toolbar shows existing actions (Move to stage, Delete) plus a new **"Enable Automation"** button with a Zap icon
3. Clicking it opens a **Dialog** (confirmation page) containing:
   - A summary: "Enable automation on X of Y selected leads"
   - A scrollable list of leads, each with:
     - Name / Company
     - Current phase
     - A checkbox (pre-checked for eligible leads, unchecked for flagged ones)
     - Warning badges: "Has replied" (amber) or "Not eligible" (red) for ineligible leads
   - Footer with Cancel and "Enable Automation" buttons
4. User can toggle individual leads on/off, then confirm
5. On confirm: batch update eligible leads with `needs_action=true`, `next_action_key`, `eligible_at` set to the correct future time

### Technical Details

**New component**: `src/components/dashboard/BulkAutomationDialog.tsx`
- Props: `selectedLeads: EnrichedLead[]`, `open: boolean`, `onOpenChange`, `onSuccess`
- Categorizes leads into eligible vs flagged
- Flagging logic:
  - `lead.last_inbound_at` exists and motion is not `nurture` --> "Has replied"
  - Motion not in `["outbound_prospecting", "inbound_response"]` --> "Not eligible (motion)"
  - Stage is `closed_won` or `closed_lost` --> "Not eligible (closed)"
  - Already has automation enabled (`eligible_at` set + `needs_action`) --> "Already active"
- Uses same scheduling logic as `AutomationPreviewCard`: calculates `eligible_at` based on whether lead has prior outbound, uses `getMotionIntervals` for gap days
- Performs a single batch update via `supabase.from("leads").update(...).in("id", ids)`

**Modified file**: `src/components/dashboard/LeadTable.tsx`
- Add "Enable Automation" button to the bulk actions toolbar (next to "Move to stage" and "Delete")
- Import and render `BulkAutomationDialog` when triggered
- New state: `bulkAutomationOpen: boolean`

