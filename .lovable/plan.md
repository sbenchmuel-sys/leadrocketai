

## Problem

The snooze dismissal doesn't work because `action_dismissed_at` is **never fetched from the database**.

In `src/lib/dashboardMetricsService.ts` (line 59-67), the `DASHBOARD_LEAD_COLUMNS` query string lists every column needed for the dashboard — but `action_dismissed_at` is missing. So when `classifyRevenueState` checks `(lead as any).action_dismissed_at`, it's always `undefined`, and the snooze gate never fires.

The `dismissLeadAction` function correctly writes `action_dismissed_at` to the database, and `classifyRevenueState` correctly checks it — but the data is simply never loaded.

## Fix

### 1. Add `action_dismissed_at` to `DASHBOARD_LEAD_COLUMNS`

In `src/lib/dashboardMetricsService.ts`, add `action_dismissed_at` to the column list on line 59-67.

### 2. Audit: Are there other fetch paths that also miss this column?

I checked all consumers of `classifyRevenueState` — it's only called from `dashboardMetricsService.ts`, which uses `fetchLeads()`. So this single fix covers the entire flow.

### 3. Verify other similar fields aren't missing

Quick audit of fields accessed via `(lead as any)` in `classifyRevenueState`:
- `ooo_until` — present in `DASHBOARD_LEAD_COLUMNS` (line 66)
- `action_dismissed_at` — **MISSING** (this bug)

Both are now accounted for. No other missing fields.

### Files to change

- **`src/lib/dashboardMetricsService.ts`** — Add `action_dismissed_at` to `DASHBOARD_LEAD_COLUMNS` (one word added to line 66).

This is a one-line fix. Once the column is fetched, the existing snooze guard in `classifyRevenueState` will work correctly — snoozed leads will be excluded from `action_required` and fall through to their natural state (likely `active`).

