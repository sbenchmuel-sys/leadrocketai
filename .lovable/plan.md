

## Fix: Dashboard Top Row Filter Connections

### Problem
The four executive tiles in the top row (Active Leads, Needs Action, Warming Up, Automation Running) should all be clickable to filter the leads table. Currently, only "Warming Up" has click-to-filter wired up. The other three cards are completely inert -- clicking them does nothing.

### What Changes

**1. SummaryCards component** (`src/components/dashboard/SummaryCards.tsx`)
- Add a single generic `onCardClick` callback prop that receives the card key as a filter type
- Make ALL four cards clickable with `cursor-pointer`
- Show active ring styling on whichever card matches `activeFilter`:
  - "active" filter highlights "Active Leads"
  - "needs_action" highlights "Needs Action"
  - "warming_up" highlights "Warming Up"
  - "automation" highlights "Automation Running" (new filter type)
- Remove the separate `onWarmingUpClick` prop in favor of the unified callback

**2. FilterType update** (`src/components/dashboard/SummaryCards.tsx`)
- Add `"automation"` to the `FilterType` union so it can be used as a filter value

**3. Dashboard page** (`src/pages/Dashboard.tsx`)
- Replace `onWarmingUpClick` with a unified `onCardClick` handler that calls `setActiveFilter` with the appropriate filter and resets `activeStage`
- Remove the standalone `handleWarmingUpClick` function
- Add filtering logic for `"automation"` in the `filteredLeads` memo: filter leads where `nurture_mode === "auto"` and `nurture_status === "active"`
- Map card keys to filter types: `active` -> `"active"`, `needs_action` -> `"needs_action"`, `warming_up` -> `"warming_up"`, `automation` -> `"automation"`

### How Filtering Works After Fix

| Card Clicked | Filter Applied | Leads Shown |
|---|---|---|
| Active Leads | `active` | Leads not in closed_won / closed_lost |
| Needs Action | `needs_action` | Leads with `needs_action = true` |
| Warming Up | `warming_up` | Leads from `warmingUpLeads` array |
| Automation Running | `automation` | Leads with `nurture_mode=auto` and `nurture_status=active` |

Clicking the same card again toggles back to "all" (show everything).

### Technical Details

```text
SummaryCards props (before):
  onWarmingUpClick?: () => void

SummaryCards props (after):
  onCardClick?: (filter: FilterType) => void
```

The `filteredLeads` memo gains one new branch:

```text
else if (activeFilter === "automation") {
  result = result.filter(l => l.nurture_mode === "auto" && l.nurture_status === "active")
}
```

No changes to underlying data fetching, metric derivation, Intelligence Cards, Deal Flow Bar, or Action Required panel.

