

## Problem

When leads are moved to Nurture, the scheduled email times don't appear on the lead detail card. The root cause is that three critical nurture fields are missing from the database query:

- `nurture_status` (needed to show/hide the nurture card)
- `nurture_mode` (needed to display "Review" vs "Auto" mode)
- `nurture_theme` (needed for theme display)

These fields exist in the database and are set correctly by `motionUpdater.ts`, but the `getLeadDetail` query in `supabaseQueries.ts` never fetches them. The code accesses them via `(lead as any)` casts, which silently returns `undefined` instead of the actual values.

## Fix

**File: `src/lib/supabaseQueries.ts`**

1. Add `nurture_status`, `nurture_mode`, and `nurture_theme` to the `LeadDetail` type Pick list (line 131).
2. Add the same three columns to the `.select()` string in the `getLeadDetail` query (line 150).

This is a 2-line change that will make the NurturePreviewCard render correctly, showing scheduled email dates, cadence info, and preview/generate buttons.

