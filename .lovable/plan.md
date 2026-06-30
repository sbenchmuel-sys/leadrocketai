## Goal

In the All-leads table, replace the misleading "New" status for leads that are already enrolled in an outreach cadence. Show **"In outreach"** instead, and surface which cadence they came from. Replied leads keep behaving the way they already do (they move to the Replied queue tab + flip to Hot).

## Why "New" shows today

`leadStatus()` in `src/lib/leadStatus.ts` decides the colored status word using only the lead's `revenueState` + `stage`. It has no knowledge of `campaign_id` / `automation_mode`. So an enrolled lead whose stage is still `new` (e.g. Ann Balosky — enrolled but never engaged) renders as **New** in the Status column, even though the "In outreach" chip already counts her correctly.

The chip uses `isInAutomation()` (campaign_id or automation_mode, minus reply-paused). The Status column needs to use the same signal.

## Changes

### 1. `src/lib/leadStatus.ts` — add a new status key

- Add `"in_outreach"` to `LeadStatusKey`.
- New priority order inside `leadStatus(lead)`:
  1. `hot` — revenueState `heating_up` (unchanged; e.g. replies)
  2. `quiet` — revenueState `long_cycle` (unchanged)
  3. **`in_outreach`** — `isEnrolled(lead) && !hasUnansweredReply(lead)` → label **"In outreach"**, class `text-violet-600 dark:text-violet-400` (distinct from blue "New" and amber "Hot"; matches the existing outreach iconography elsewhere).
  4. `new` — stage `new` (unchanged)
  5. `active` — default

Replied leads naturally fall through to `hot` first (revenueState flips to `heating_up` on inbound), so "reply wins" is preserved with zero extra logic. The cadence stays linked via `campaign_id` even after the reply — used for the tag below.

### 2. `src/lib/leadStatus.ts` — export cadence-name helper

Add `leadCadenceName(lead): string | null` that returns the campaign name if `lead.campaign_id` is set (campaign name already lives on `EnrichedLead` via the dashboard metrics join — verify; if not, expose it through `getDashboardMetrics`).

### 3. `src/pages/Leads.tsx` — render cadence tag under the lead name

Below the company line in the Lead column, add a small muted line:

```
Ann Balosky
Ace Hardware Corporation
↳ MFUC26                     ← only when leadCadenceName(lead) is non-null
```

Single line, `text-xs text-muted-foreground`, truncated. Shown for both currently-enrolled leads AND replied-but-previously-enrolled leads — that's the "tag from which cadence" the user asked for.

### 4. `isNewLead()` — no change needed

Already excludes enrolled leads, so the **New** chip count stays accurate. The numbers in the screenshot ("New · 96" vs "In outreach · 9") will not shift; only the per-row Status word changes for the 9 enrolled leads.

### 5. Tests

Add a case to `src/lib/leadStatus.test.ts`:
- Enrolled + no reply → `in_outreach`
- Enrolled + unanswered reply → `hot` (reply wins)
- Not enrolled + stage new → `new` (unchanged)

## Out of scope

- Queue tab routing for replies — already works as the user described (replied outreach leads appear in Replied, not Outreach).
- "Last reply" column, Auto column — unchanged.
- Cadence-name backfill on the campaign join — only add to the metrics query if it isn't already there.
