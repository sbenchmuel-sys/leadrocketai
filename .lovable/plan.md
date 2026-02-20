
## Root Cause: Race Condition in the Daily Cap Check

### What the Database Proves

The automation log shows leads like "Rudy Siregar" receiving **10 emails** in 14 minutes, and others getting 4 emails within **2 seconds** of each other. This is a textbook race condition — not a logic error.

### Why the "1 email per day" guard fails

The cron job runs automation-executor **every 15 minutes**. Each run queries for all eligible leads and processes them in a loop. Here is what happens when a lead is picked up in two near-simultaneous or closely-spaced runs:

```text
Run #1 (14:18:42):  Fetches lead — todaySentCount = 0 → PASSES cap check
Run #2 (14:18:43):  Fetches lead — todaySentCount = 0 → PASSES cap check (Run #1 hasn't written to DB yet!)
Run #1 (14:18:43):  Sends email → writes "sent" to automation_log
Run #2 (14:18:43):  Sends email → writes "sent" to automation_log  ← DUPLICATE
```

The guard at line 412 (`SELECT count(*) WHERE status='sent' AND gte created_at today`) reads from the database **before** the current run has committed its own write. So concurrent or overlapping runs both read `count = 0`, both pass, and both send.

This is confirmed by the timestamps: most duplicate pairs are within **1–2 seconds** of each other — physically impossible unless two execution instances ran in parallel and read the same count simultaneously.

### Secondary Issue: The gmail-send 500→200 change made things worse

The last diff changed `gmail-send` to always return HTTP 200 (even on error). The automation-executor checks `if (!sendResponse.ok)` at line 598 — with the old 500 it would skip and push `eligible_at` forward 15 minutes. Now with 200, this check **never triggers**, so even if gmail-send internally fails, the executor proceeds to write `status: "sent"` to automation_log and schedule the next step. This compounded the blast for the Feb 19 batch (3 sends per lead within seconds).

### The Fix: Atomic Database-Level Lock

The only reliable fix for a race condition is to make the "check + write" operation **atomic at the database level**, using PostgreSQL's `INSERT ... ON CONFLICT DO NOTHING` pattern with a unique constraint. This is a 2-part change:

**Part 1 — Database migration:** Add a unique partial index to `automation_log` that enforces at most one `sent` record per `(lead_id, action_key)` per calendar day:
```sql
CREATE UNIQUE INDEX automation_log_one_per_day_unique
ON automation_log (lead_id, action_key, date_trunc('day', created_at))
WHERE status = 'sent';
```

This means even if two concurrent runs try to insert a `sent` record for the same lead+action on the same day, the database will reject the second one at the INSERT level — no race condition possible.

**Part 2 — Edge function guard enhancement:** In `automation-executor/index.ts`, change the automation_log INSERT at line 649 to use `upsert` with `ignoreDuplicates: true`. If the insert is rejected by the unique constraint, log a "duplicate blocked by DB" message and skip — don't send. This replaces the pre-flight count-check (which is racy) with a post-send atomic commit (which is safe).

Additionally, restore the `sendResponse.ok` check to correctly catch the HTTP status from gmail-send. Since gmail-send now always returns 200, the executor must check `sendResult.ok` (the JSON body) instead of the HTTP status code.

### Technical Changes Summary

| Change | Location | Why |
|--------|----------|-----|
| Add unique partial index on `automation_log` | Database migration | Atomic DB-level dedup — prevents concurrent inserts |
| Replace pre-flight count check with post-send conflict detection | `automation-executor/index.ts` | Eliminates the read-before-write race window |
| Fix `sendResponse.ok` → `sendResult.ok` check | `automation-executor/index.ts` | gmail-send now always returns 200; must check JSON body |
| Keep existing GUARD 2 (action-level dedup) | `automation-executor/index.ts` | Still useful as a first-pass filter, but DB constraint is the true safety |

### What This Does NOT Change
- The cron schedule (still every 15 min — the fix makes concurrent runs safe)
- The existing OOO, nurture, meeting, unsubscribe, and reply safety checks
- The gmail-send function (no changes needed there)
- Any existing data (the unique index is on new inserts only)

### No Data Recovery Needed
The damaged leads have already been over-sent. The fix prevents this from happening again. Affected leads can be left as-is since they received the emails (unpleasantly), or manually reviewed via the dashboard.
