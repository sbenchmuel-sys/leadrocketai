## Answers to your 4 questions

1. **When does Sean show up in "Queue → Outreach"?**
   Enrollment writes one `campaign_touch` per step with an `eligible_at` time. The `campaign-touch-scheduler` cron runs every 5 min and outbound sends are staggered 09:00–16:30 in your workspace timezone. So: within a few minutes during business hours, otherwise the next morning. He appears in the Outreach tab the moment his first touch becomes eligible AND the step needs a rep (manual / review-mode email / non-email).

2. **Why does "Auto" say On when nothing is auto-sending?**
   The Auto column currently means "enrolled in something" (`leads.campaign_id IS NOT NULL` OR `automation_mode IS NOT NULL`), not "will send without me". Enrollment stamps `campaign_id`, so it lights up even for review-mode campaigns where every email needs your click. That's the bug.

3. **Where do I see upcoming drafts to approve in advance?**
   Today: nowhere. Drafts are only generated when a touch becomes due. We'll add an editable preview (see Section C).

4. **How do I know which outreach he was added to?**
   Today: nowhere on the Leads list or the lead header. Gap fixed in Section A.

---

## UI fixes (frontend only, no scheduler / executor / RLS changes)

### A. Show the outreach on Leads and lead detail
- `src/lib/supabaseQueries.ts` (`getLeadsList`): add `campaign_id` to the select. Follow with one `campaigns` fetch (`id, name, send_mode`) for the distinct ids; attach as `campaign: { id, name, sendMode }` on the enriched lead.
- `src/lib/dashboardUtils.ts`: pass `campaign` through `EnrichedLead`.
- `src/pages/Leads.tsx`: new compact "Outreach" column (Status → **Outreach** → Auto) rendering the campaign name as a `Link` to `/app/automations/{id}`; "—" when none.
- `src/components/lead/LeadDetailHeader.tsx`: render `In outreach: <name>` chip (same Link) when the lead has a campaign.

### B. Make the "Auto" column tell the truth
- `src/lib/leadStatus.ts`: add `automationMode(lead): "auto" | "review" | "off"` using the joined campaign — `"auto"` only when enrolled AND `campaign.send_mode === 'auto'` (legacy `automation_mode` keeps mapping to `"auto"`); `"review"` when enrolled but `send_mode` is `review`/`manual`; `"off"` otherwise.
- `src/pages/Leads.tsx`: replace the on/off cell with a small badge — green **Auto**, amber **Review**, muted **Off**.
- `isInAutomation` and the "In automation" chip predicate are unchanged so counts don't shift; executor consent gate untouched.

### C. Upcoming drafts the rep can preview AND edit
- New `src/components/lead/UpcomingTouchesCard.tsx`, mounted on `src/pages/LeadDetail.tsx` when the lead has a `campaign_id`.
- Reads `campaign_touch` rows for `(lead_id, campaign_id)` with `status IN ('scheduled','queued')` ordered by `eligible_at`, joined with `campaign_steps` to show: step number, channel, eligible time, one-line preview from `campaign_step_content`.
- Each row has one primary button **Preview & edit draft** that:
  1. Calls the existing `useBackgroundDraftQueue.enqueue(lead.id, { campaignTouchId, stepNumber })` path (same as the queue "Draft" wand). When ready, opens `EmailActionDialog` with `prefilledSubject` + `prefilledBody` — **this dialog is the full composer, so the rep can edit subject and body before sending**. Same confirm-before-send gate as everywhere else. No read-only state.
  2. Sending uses the existing dialog flow; we do NOT mutate the scheduled `campaign_touch` here — sending early is treated as a manual send (matches today's behavior on review-mode steps).
- Same editable composer behavior applies to the existing `ReEngagementCard` — it already opens `EmailActionDialog`, which is editable, so no change needed there.

### D. Outreach-enrolled leads stay in the Outreach tab only
**This is the contract you described — implementing it now.** Today `fetchQueueLeads` does not look at enrollment, so a lead enrolled in a campaign can still appear under Replied or Follow up driven by its `next_action_key`. We'll add a single client-side filter in the reactive snapshot path so:

- A lead with `campaign_id IS NOT NULL` is **excluded** from the Replied and Follow up tabs UNLESS `next_action_key === 'reply_now'` (the customer has replied and the executor's instant-pause kicked in — same signal Replied already uses). When they reply, they move to Replied as you described.
- The Outreach tab is unaffected — it reads from `fetchOutreachQueue` / `campaign_touch`, not from this snapshot.
- Tab counts (`chipCounts`) come off the same filtered snapshot, so the numbers match what the rep sees.

Implementation:
- `src/lib/queueQueries.ts`: add `campaign_id` to `QUEUE_LEAD_COLUMNS` and `QueueLeadRow`; export a small `isEnrolledNonReply(lead)` predicate (`!!campaign_id && next_action_key !== 'reply_now'`).
- `src/lib/queueQueries.ts`: in `fetchQueueLeads`, after the intent-hide reduction, drop rows where `isEnrolledNonReply` is true (count them into a new `hiddenByOutreach` returned alongside `hiddenCount`, but fold into `hiddenCount` so the existing "N routine items hidden · show all" header keeps working — toggling Show all does NOT bring them back; they belong to Outreach).
- No change to `chipForLead`, no change to RLS, no change to the executor or scheduler.

### Files touched
- `src/lib/supabaseQueries.ts` — add `campaign_id` + campaigns fetch.
- `src/lib/dashboardUtils.ts` — pass `campaign` through.
- `src/lib/leadStatus.ts` — new `automationMode()`.
- `src/lib/queueQueries.ts` — `campaign_id` on row + outreach-filter in `fetchQueueLeads`.
- `src/pages/Leads.tsx` — Outreach column + Auto badge.
- `src/components/lead/LeadDetailHeader.tsx` — outreach chip.
- `src/components/lead/UpcomingTouchesCard.tsx` (new) + mount in `src/pages/LeadDetail.tsx`.

### Explicitly out of scope
- No change to enrollment, `campaign-touch-scheduler`, `automation-executor`, RLS, the 09:00–16:30 staggering, or `playbookResolver`.
- No new tables, no migrations.
- No change to the Outreach tab's data source.
