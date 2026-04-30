# Filterable, Paginated Lead Table

## Goal
Make the Active / Long Cycle / Automation tabs efficient for bulk triage:
- Default view = list (table), remembered per tab
- Filter by Phase, Last Activity (direction + recency), Next Action group, Automation on/off
- Page through results in batches of 25 with Next/Prev + a "Show all" toggle
- Bulk-select the visible page (or all filtered) → existing Enable Automation / Move to Nurture flows

## Scope (per your answers)
- **Filter bar visible on**: Active, Long Cycle, Automation tabs only. Action Required and Heating Up keep their curated layouts untouched.
- **Default view**: Per-tab persistence. New users see table view on the 3 supported tabs; queue stays the default elsewhere. User toggles are remembered per tab in localStorage.
- **Last Activity filter**: Direction + recency combined chips: `Recent inbound (≤7d)`, `Recent outbound (≤7d)`, `Stale (>14d)`, `Never contacted`.
- **Next Action filter**: Action-type groups from `getActionType()` — Reply, Follow-up, Recap, Nurture, Closing, None.

## UI

```text
┌─ Command Strip (Active | Action Required | Heating Up | Long Cycle | Automation) ─┐
│                                                                                    │
│ [Search...]  [Phase ▾] [Activity ▾] [Next Action ▾] [Automation ▾]  [Clear]  ⊞ ☰  │
│                                                                                    │
│ ┌─ 12 selected ── [Move to stage] [Source] [Enable Automation] [Nurture] [Delete] ─┐│
│ │                                                                                  ││
│ ├──────────────────────────── Lead Table (25 rows) ──────────────────────────────┤│
│ │ ☐ Lead    Phase    Last Activity    Next Action    Automation                  ││
│ │ ...                                                                            ││
│ └──────────────────────────── 1–25 of 187 ── ‹ Prev  Next ›  [Show all] ────────┘│
└────────────────────────────────────────────────────────────────────────────────────┘
```

Filters render as `Select` dropdowns (multi-select where it makes sense, e.g., Phase). Active filters show a count badge on the trigger; "Clear" appears when any filter is set.

## Behavior details

**Filter logic** (all AND-combined, applied before pagination):
- **Phase**: multi-select of `DisplayPhase` values present in current tab (Prospecting, Engaged, Post-Meeting, Closing, Nurture, Closed). Uses `lead.displayPhase`.
- **Activity**: single-select chip:
  - `Recent inbound (≤7d)` → `last_inbound_at` within 7d AND `last_inbound_at > last_outbound_at`
  - `Recent outbound (≤7d)` → `last_outbound_at` within 7d AND `last_outbound_at >= last_inbound_at`
  - `Stale (>14d)` → no activity in 14d (uses existing `getStaleLeads` rule)
  - `Never contacted` → `!first_outbound_at && !last_inbound_at`
- **Next Action**: multi-select of action-type groups; maps via `getActionType(lead.next_action_key)`. "None" = `!needs_action`.
- **Automation**: `On` (`eligible_at && needs_action`, OR `nurture_mode='auto' && nurture_status='active'`) / `Off` / `All`.

**Pagination**:
- Page size = 25 (constant, no per-page selector to keep it simple). "Show all" link toggles to render the entire filtered set on one page.
- Page state resets to 1 when filters or search change.
- Page state is **NOT** persisted across navigation (avoids stale pages on data refresh). Filter state IS persisted per tab.

**Select-all semantics**:
- Header checkbox selects all rows on the current page.
- When selections exist beyond the current page (e.g., user selected, then navigated), a banner appears: `12 selected on this page — [Select all 187 filtered]`.
- Bulk action toolbar already in `LeadTable` is reused unchanged. Existing `BulkAutomationDialog` accepts the selected `EnrichedLead[]` and continues to enforce its own eligibility flags (already replied, closed, etc.) — so the new filters don't bypass any consent guardrails.

**Default view per tab**:
- For the 3 supported tabs, default view = `table`.
- Queue/Table toggle is shown (today it's behind `flags.ui_v2`); we'll show it unconditionally on these tabs.
- Choice persists in `localStorage` keyed by tab (e.g., `dashboard_view_mode_v2.active = "table"`).

## Files to change

| File | Change |
|---|---|
| `src/lib/dashboardStateCache.ts` | Add localStorage persistence; `viewMode` becomes `Record<RevenueState, ViewMode>`; add per-tab filter state (`phaseFilter[]`, `activityFilter`, `nextActionFilter[]`, `automationFilter`); add `pageIndex` (transient, not persisted). |
| `src/components/dashboard/FilterBar.tsx` (new) | Renders the 4 dropdowns + Clear button. Self-contained, takes current state + onChange callbacks. |
| `src/components/dashboard/LeadTable.tsx` | (1) Accept `filters` + `pagination` props OR consume the cache directly. (2) Apply filters in the existing `.filter().sort()` chain inside the `<TableBody>`. (3) Slice rows for current page. (4) Add `<TableFooter>` with `1–25 of N · ‹ Prev  Next ›  [Show all]`. (5) Update select-all to operate on visible page + show "select all filtered" banner when partial. |
| `src/pages/Dashboard.tsx` | (1) Read per-tab default view mode from cache. (2) Render `<FilterBar>` above the table for `active` / `long_cycle` / `automation` tabs. (3) Always show queue/table toggle on those tabs (drop the `flags.ui_v2` gate there only). (4) Pass `filteredLeads` (post-filter) to `LeadTable`; let table handle pagination internally. |

No backend / RLS / migration changes — all logic is client-side over the already-fetched `metrics.leads` array.

## Out of scope (not changing now)
- Action Required / Heating Up tab layouts.
- Server-side pagination (current dashboard fetches all leads in one call; if scale becomes an issue we'd revisit).
- Saved filter presets (can add later, mirroring `inboxStateCache.savedViews`).
- New filter dimensions (channel, source, owner) — easy to add later in the same FilterBar component.

## Acceptance check
1. Open Active tab → list view, 25 rows, page controls, all 4 filters render.
2. Apply Phase=Engaged + Automation=Off → rows update, count badge shows on filter triggers, page resets to 1.
3. Toggle to queue view → choice persists when switching tabs and back.
4. Select all on page → bulk bar shows "X selected"; "Enable Automation" / "Move to Nurture" still go through existing dialogs with consent (no silent enables — Automation Consent rule preserved).
5. "Show all" → renders full filtered set, hides Next/Prev.
6. Switch to Action Required tab → filter bar is hidden, original layout intact.
