## What's actually happening with Test2

Test2 *is* enrolled in TEST4 — the database confirms it:

- `campaign_enrollment` row exists (status `scheduled`, enrolled 19:55:42 UTC).
- 9 `campaign_touch` rows exist, step 1 (email) is already due (`eligible_at` 19:55:42 UTC, before "now").
- TEST4 is `active`, `send_mode = review`.

The reason the Outreach tab is empty:

`fetchOutreachQueue` only shows touches whose `status = 'queued'`. New touches are written as `'scheduled'`. The `campaign-touch-scheduler` cron is the only thing that promotes `scheduled → queued`, and it runs every 5 minutes. The last run was 19:55:03 — one second *before* Test2 was enrolled. So the touch will only flip to `queued` (and the card will only appear) on the next cron tick at ~20:00 UTC.

That's exactly the "almost right away" gap you're seeing.

## Fix

Mirror the scheduler's first-step promotion inline at the end of `enrollLeadsInCampaign`, so the rep sees the card the moment they click Enroll instead of waiting up to 5 minutes for cron.

Scope is intentionally narrow — promote only the touches the scheduler would have promoted on its very next run, with the same gates, so behavior stays identical and we don't accidentally surface anything the scheduler would have suppressed.

### Logic (runs once, right after touch rows are inserted)

For each enrollment just created, look at its **step 1** touch only:

1. Skip if `eligible_at > now` (lead got a staggered start — wait for cron).
2. Skip if lead `unsubscribed` (already filtered earlier, belt-and-suspenders).
3. **Email channel:**
   - Campaign `send_mode = 'automatic'` AND workspace auto-send fully gated (gate on + timezone + postal address) → leave as `scheduled` (owned by `automation-executor`, same as scheduler does).
   - Otherwise (review mode, or automatic-but-not-yet-sendable) → flip touch to `'queued'`, flip enrollment to `'active'`. Card appears in Outreach tab.
4. **Manual channel (LinkedIn / voice / SMS / WhatsApp) as step 1:**
   - If lead can't receive (no LinkedIn URL / no phone / etc.) → leave for cron to auto-skip+advance (replicating `advanceColdEnrollment` here would duplicate too much logic for a rare path).
   - Otherwise → flip touch to `'queued'`, flip enrollment to `'active'`.

Everything else (steps 2+, staggered starts, max-age expiry, reply bridge) keeps going through the 5-min cron exactly as today.

### File touched

- `src/lib/campaignEnrollment.ts` — add a `promoteFirstDueTouches(...)` helper and call it after the touch-insert block (around line 793). Reuses `campaign.send_mode` and the workspace auto-send / timezone / postal-address values already fetched in `gatherEnrollmentContext`; one extra read for `workspace_automation_settings.auto_send_enabled` if not already in scope.

### What I'm *not* changing

- `fetchOutreachQueue` still reads only `status='queued'` (single source of truth for "ready for rep").
- `campaign-touch-scheduler` keeps running every 5 min and is still authoritative for steps 2+, manual auto-skips, reply bridge, and any first touches we skipped above.
- No schema changes, no new edge function, no cron change.

### Validation

After the change:
1. Add a fresh lead to TEST4 from the UI.
2. Confirm the touch row's `status` is `queued` (not `scheduled`) immediately after enroll completes.
3. Confirm the lead's card appears in the Outreach tab on next render (no wait).
4. Test2's existing row: nothing to backfill — the 20:00 cron tick will promote it the normal way. (If you want it visible right now I can manually flip that one row as well — say the word.)
