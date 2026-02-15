

## Dashboard and Leads Page UI Updates

Six changes across the dashboard and leads page.

---

### 1. Envelope icon next to Automation column (Dashboard LeadTable)

Add a small Mail icon button in the Automation cell, next to the automation status indicator. Clicking it opens the email compose dialog for that lead (same behavior as the existing `renderEmailComposeButton`).

**File:** `src/components/dashboard/LeadTable.tsx` (lines 734-746)

---

### 2. New "Automation" tab in CommandStrip

Add a fifth revenue state: `"automation"`. Leads with active automation (`eligible_at` set AND `needs_action`, or `nurture_mode === "auto"` and `nurture_status === "active"`) are classified into the "Automation" state instead of their normal state. When automation stops (not pauses), the lead returns to its natural revenue state.

**Files:**
- `src/lib/dashboardUtils.ts` -- Add `"automation"` to `RevenueState` type, update `REVENUE_STATE_LABELS`, and update `classifyRevenueState` to check automation status BEFORE the existing priority chain (so automated leads are diverted away from action_required)
- `src/components/dashboard/CommandStrip.tsx` -- Add `{ key: "automation", label: "Automation" }` segment after "Long Cycle"
- `src/lib/dashboardMetricsService.ts` -- Add `automation: 0` to `revenueStateCounts` initialization
- `src/pages/Dashboard.tsx` -- Add `automation: 0` to the fallback counts object

---

### 3. Automation column shows "Off" or flash icon, not "Review"

Replace the "Review" badge with the Zap (flash) icon. The automation cell now shows:
- **Zap icon (green)** when automation is actively running
- **"Off"** text when automation is off

No "Review" state displayed.

**File:** `src/components/dashboard/LeadTable.tsx` (lines 734-746) -- Remove the `isReview` badge rendering entirely

---

### 4. Search bar in dashboard LeadTable

Add a search input inside the LeadTable card header that filters leads by name or company. The search is local (client-side) on the already-loaded leads.

**File:** `src/components/dashboard/LeadTable.tsx` -- Add state `searchQuery`, add Search input in CardHeader, filter `leads` by name/company before rendering

---

### 5. Remove Source column from dashboard, make it selectable in Leads page

Remove the "Source" column (`<TableHead>` and `<TableCell>` with `SourceDropdown`) from the dashboard LeadTable.

In the Leads page (`src/pages/Leads.tsx`), replace the static "Strategy" badge in the Source/Strategy column with a `SourceDropdown` component (same one used in the dashboard currently) so users can change source directly from the leads page.

**Files:**
- `src/components/dashboard/LeadTable.tsx` -- Remove Source TableHead and TableCell
- `src/pages/Leads.tsx` -- Import `SourceDropdown` and replace the static Badge in the Strategy column with the dropdown

---

### 6. Remove Status column from Leads page

Remove the "Status" column (`<TableHead>` and `<TableCell>`) from the Leads page table.

**File:** `src/pages/Leads.tsx` -- Remove the Status TableHead and TableCell

---

### Technical Summary

| File | Changes |
|------|---------|
| `src/lib/dashboardUtils.ts` | Add `"automation"` to `RevenueState`, update classification logic |
| `src/lib/dashboardMetricsService.ts` | Add `automation: 0` to counts init |
| `src/components/dashboard/CommandStrip.tsx` | Add Automation segment |
| `src/pages/Dashboard.tsx` | Add `automation: 0` to fallback counts |
| `src/components/dashboard/LeadTable.tsx` | Add envelope icon in automation cell, remove "Review" badge, remove Source column, add search bar |
| `src/pages/Leads.tsx` | Remove Status column, replace Strategy badge with SourceDropdown |

