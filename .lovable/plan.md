## Upcoming touches strip — grouped by campaign

Add a new section above the lead list in the Outreach tab of the Queue page that surfaces scheduled (not-yet-queued) touches, so reps can see leads that are "parked" waiting for their next eligibility window instead of them disappearing from view.

### Behavior

- One collapsed row per **campaign** (not per lead). Example:
  - `MFUC26 — 87 leads scheduled · next ready tomorrow 9:00 AM`
  - Sub-line: `12 missing LinkedIn URL · 3 missing phone` (only shown if there are auto-skip reasons in the preceding step).
- Click a row → expands inline to show individual leads (virtualised list, capped at 50 visible with a "Show all" link that opens a drawer/page for the full set).
- Each lead row inside the expansion shows: lead name + company, next channel icon, humanized "Ready at" (e.g. "Tomorrow 9:00 AM"), and inferred auto-skip reason for the previous step if any.
- Empty state: hide the strip entirely when no scheduled touches exist.
- Sorting: campaigns sorted by soonest `next_ready_at` ascending.

### Scope rules

- Only show touches with `status = 'scheduled'` belonging to **active** enrollments (`campaign_enrollment.status = 'active'`).
- Exclude touches where the lead is already represented in the main Outreach list (status `queued`) — the strip is strictly forward-looking.
- Workspace-scoped via existing RLS.

### Files

- New: `src/components/queue/UpcomingTouchesStrip.tsx` — the grouped/collapsible component.
- New: `src/lib/upcomingTouchesQueries.ts` — single query that groups by `campaign_id`, returns `{ campaign_id, campaign_name, lead_count, next_ready_at, skip_reasons[], leads[] }`.
- Edit: `src/pages/Queue.tsx` — mount the strip at the top of the Outreach tab content, above the existing list.

### Technical details

- Query: select from `campaign_touch` join `campaign_enrollment` join `campaigns` and `leads`, filtered by workspace, `enrollment.status='active'`, `touch.status='scheduled'`, ordered by `scheduled_for asc`. Group client-side by `campaign_id`.
- Skip-reason inference: for each campaign, look up the immediately preceding `campaign_touch` rows with `status='skipped'` per lead and bucket by `skip_reason` (`missing_linkedin_url`, `missing_phone`, `unsubscribed`, etc.). Count and surface the top 2-3.
- Virtualisation: use the existing list virtualisation pattern if already present in Queue, otherwise simple `.slice(0, 50)` + "Show all" button that toggles a full drawer (Sheet from shadcn).
- No backend changes, no migrations. Pure read-side surfacing.

### Out of scope

- Bulk actions on scheduled touches (skip-all, reschedule).
- Editing the draft content before its scheduled time (already available via campaign editor).
- Dedicated `/outreach/upcoming` page — drawer is enough for now.
