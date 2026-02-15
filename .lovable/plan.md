
# Fix Team Analytics — Wire to Correct Data Sources

## Problem
The `compute-manager-analytics` edge function queries the `conversations` and `messages` tables (which are empty — used for WhatsApp/inbox), but all the actual activity data lives in:
- **`interactions`** table: 558 outbound emails, 100 inbound emails
- **`leads`** table: 138 leads with stage data (contacted, engaged, post_meeting)
- **`meeting_summaries`** table: 16 meeting summaries

The dashboard correctly shows zeros because the wrong tables are being queried.

## Solution
Rewrite the `compute-manager-analytics` edge function to pull from `interactions`, `leads`, and `meeting_summaries` instead of `conversations`/`messages`. The frontend (`ManagerDashboard.tsx`) and query layer (`managerAnalyticsQueries.ts`) remain unchanged — they already display whatever `manager_views` contains.

## What changes

### Edge function: `supabase/functions/compute-manager-analytics/index.ts`

Rewrite `computeRepMetrics()` to:

1. **Emails sent/received**: Query `interactions` joined to `leads` by `owner_user_id`, counting `email_outbound` vs `email_inbound`
2. **Response time**: Calculate from `interactions` per lead — time between an inbound email and the next outbound email
3. **Needs reply**: Leads where the most recent interaction is `email_inbound` and status is not closed
4. **Stage distribution**: Aggregate from `leads.stage` (contacted, engaged, post_meeting, new)
5. **Channel metrics**: Derive from `interactions.source` (gmail) and direction
6. **Meeting summaries**: Count from `meeting_summaries` per user
7. **Ghost risk**: Leads with no outbound in 14+ days where last interaction was inbound
8. **Sentiment/urgency/objections/topics**: Keep reading from `conversation_analysis` if available, but also derive basic sentiment from `leads.deal_outlook`

### No changes needed
- `src/components/manager/ManagerDashboard.tsx` — already displays from `manager_views`
- `src/lib/managerAnalyticsQueries.ts` — already reads from `manager_views`
- `manager_views` table schema — already has the right columns
- No database migrations needed

## Technical Details

The rewritten `computeRepMetrics` function will:

```text
1. Query leads WHERE owner_user_id = repUserId
2. Query interactions WHERE lead_id IN (those lead IDs)
   - Group by type/direction for sent/received counts
   - Sort per-lead by occurred_at to compute response times
3. Query meeting_summaries WHERE user_id = repUserId
4. Derive stage_distribution from leads.stage
5. Derive ghost_risk from leads with last_inbound_at > last_outbound_at
   and days since last_outbound > 14
6. Derive channel_metrics from interactions.source (gmail = email channel)
7. Keep conversation_analysis lookup as a bonus data source if available
```

Key safety points:
- The function uses `SUPABASE_SERVICE_ROLE_KEY` so RLS is bypassed (correct for a backend compute job)
- The `manager_views` table only has a SELECT policy for admin/manager roles — no data leaks
- No frontend changes, so nothing else can break
