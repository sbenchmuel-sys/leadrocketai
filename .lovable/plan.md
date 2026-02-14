

# Change Lead Source from Dashboard (Single + Bulk)

## What This Does
Adds the ability to change a lead's source type (e.g., "Outbound Prospect", "Inbound -- Website", "Event Lead", "Referral", "Manual") directly from the dashboard table -- for individual leads or in bulk. When the source changes, the system automatically updates the lead's **motion** and **origin category** to match, so the AI playbook adapts seamlessly.

## Changes

### 1. New Component: `SourceDropdown`
A compact inline dropdown (similar to the existing Phase/Mode dropdown) for the Source column in the lead table.

- Displays the current source label with its color dot
- On change, updates `source_type`, `motion`, and recalculates `origin_category` using the existing `SOURCE_PRESETS` mapping
- Triggers a dashboard refresh after update

### 2. New Utility: `updateSourceFromTable()` in `motionUpdater.ts`
A new function that:
- Accepts a lead ID and a source preset key (outbound, inbound_website, event, referral, other)
- Writes `source_type`, `motion`, and resets sequence state appropriately (clears nurture fields if moving away from nurture, etc.)
- Calls `refreshDashboard()`

### 3. Update `LeadTable.tsx`
- Replace the static source badge in the Source column with the new `SourceDropdown` component
- Add a **bulk source change** dropdown in the bulk actions bar (alongside "Move to stage..." and "Delete")

### 4. Bulk Source Change
- New `Select` in the bulk action bar: "Change source..."
- Calls `updateSourceFromTable()` for each selected lead
- Shows success toast with count

### 5. What Automatically Adapts
Because source changes update `motion`, the following systems adapt without extra work:
- **Playbook resolver** (`playbookResolver.ts`) -- uses `motion` and `source_type` to pick the right AI intent
- **Display phase** -- recalculated from the new motion
- **Color-coded bar** -- updates to match new source
- **Cadence system** -- motion-based intervals apply automatically

---

## Technical Details

### Source Preset Mapping (already exists in `SOURCE_PRESETS`)

```text
outbound          -> source_type: outbound_prospecting, motion: outbound_prospecting
inbound_website   -> source_type: contact_form,         motion: inbound_response
event             -> source_type: event_lead,            motion: outbound_prospecting
referral          -> source_type: referral,              motion: inbound_response
other             -> source_type: manual_entry,          motion: outbound_prospecting
```

### Files to Create
- `src/components/dashboard/SourceDropdown.tsx` -- inline source selector

### Files to Modify
- `src/lib/motionUpdater.ts` -- add `updateSourceFromTable()` function
- `src/components/dashboard/LeadTable.tsx` -- replace static source badge with `SourceDropdown`, add bulk source select to toolbar

### No Database Changes Required
All fields (`source_type`, `motion`, `stage`) already exist in the leads table.

