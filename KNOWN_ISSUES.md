# KNOWN_ISSUES.md

Living list of issues we've decided to defer, with the phase or PR
where each is scheduled to be addressed. Entries link back to the
audit docs ([AUDIT.md](AUDIT.md), [EDGE_CASES.md](EDGE_CASES.md),
[BULK_OPS_INVENTORY.md](BULK_OPS_INVENTORY.md)) for context.

Phases referenced here are the action-queue redesign rollout:
- **Phase 1** — schema + backfill + dead-code cleanup (current).
- **Phase 1.5** — bulk-move-to-nurture guardrail (ships immediately after Phase 1).
- **Phase 2a** — sync-path detector wiring, classifier, UI for new column.
- **Phase 2b** — Lead List bulk-mover redesign.
- **Phase 2.5** — runtime scans to size deferred risks.
- **Phase 3** — Lead Detail tab retirement.

---

## PR #38 — classify-timeline-intent-backfill not registered in config.toml

The `classify-timeline-intent-backfill` edge function source was committed in PR #38 but not registered in `supabase/config.toml`, so it was not auto-deployed on merge and required a separate manual deployment before it could be invoked. Phase 2a should ensure any new edge functions are registered in `supabase/config.toml` as part of the same PR that adds the function source.

---

## ActionRequiredPanel.tsx — pending decision

File has zero call-sites but was actively co-maintained alongside
PriorityActions in PR 2.4 (May 4 commit 25fe9ad) and Codex triage
cleanup (May 11 commit 4296e6f). Behavior mirrors PriorityActions
(snooze, permanent-dismiss with Undo toast). Migration
20260504100001 references both as parallel surfaces.

Status: NOT deleted in PR #38. Author does not recall whether recent
edits were intentional warming or reflexive parallel maintenance.
Possible Sales Brain surfacing artifact — re-evaluate during the
Sales Brain redesign conversation (planned Phase 3).

---

## Bulk operations

### Bulk-move-to-nurture clobbering risk
**Scheduled fix: Phase 1.5.**
[BULK_OPS_INVENTORY.md §B2](BULK_OPS_INVENTORY.md#b2-bulk-move-to-nurture).
"Move to Nurture" in `LeadTable.tsx` updates `motion`, `nurture_status`,
`nurture_mode`, `nurture_cadence`, `next_action_key`, `eligible_at`,
`action_reason_code`, and `mode_changed_at` on every selected lead with
no eligibility check or warning — leads already running an outbound
sequence get clobbered mid-flight and the customer sees half a
sequence followed by a nurture switch. Phase 1.5 will add an
active-automation eligibility check and a per-lead confirm dialog
modelled on `BulkAutomationDialog`'s `categorizeLead()` flag pattern.

### Bulk stage and bulk source change fire without confirmation
**Scheduled fix: Phase 2b.**
[BULK_OPS_INVENTORY.md §B3](BULK_OPS_INVENTORY.md#b3-bulk-stage-change),
[§B4](BULK_OPS_INVENTORY.md#b4-bulk-source-change). Both controls in
`LeadTable.tsx` fire the moment the rep changes a `<Select>` value
— no confirmation step, no undo, no per-lead categorization. Risk
amplifies when these controls move onto a more-used Lead List
surface. Phase 2b will wrap both in a `AlertDialog` mirroring the
delete flow and surface a "Will affect N leads with active automation"
warning.

### Bulk delete duplicated across two surfaces
**Scheduled consolidation: Phase 2b.**
[BULK_OPS_INVENTORY.md §B5](BULK_OPS_INVENTORY.md#b5-bulk-delete--dashboard-variant),
[§B6](BULK_OPS_INVENTORY.md#b6-bulk-delete--app-leads-page-variant).
Dashboard's `LeadTable.tsx` and `/app/leads`'s `Leads.tsx` each
implement their own `handleBulkDelete` calling
`Promise.all(deleteLead(id))`. No shared helper. Phase 2b will
extract `bulkDeleteLeads(leadIds)` in `supabaseQueries.ts` using
`.delete().in('id', ids)` and a single `<BulkDeleteDialog>` consumed
from both surfaces.

### Multi-select state machinery re-implemented 4 times
**Scheduled extraction: Phase 2b.**
The `useState<Set<string>>` + add/delete/toggle/select-all logic is
copy-pasted across `LeadTable.tsx`, `Leads.tsx`, `PendingLeadsTab.tsx`,
and `BulkAutomationDialog.tsx`. Phase 2b extracts `useMultiSelect(items, { pageIds? })`
and `useBulkAction(items, mutator, { optimistic, retry })` hooks so
every new bulk surface is a one-line wiring exercise. The
optimistic-with-rollback pattern in
[PendingLeadsTab §B9–B10](BULK_OPS_INVENTORY.md#b9-bulk-approve-lead-candidates)
is the template.

---

## Detection edge cases

### SaaS auto-reply false positives via OOO headers
**Scheduled scan: Phase 2.5.**
[EDGE_CASES.md §6](EDGE_CASES.md#6-saas-tool-auto-replies-salesforce-zendesk-etc).
Salesforce / Zendesk / similar notifications often set
`Auto-Submitted: auto-generated` or `X-Auto-Response-Suppress: <any>`,
which trips OOO header detection in
[_shared/oooDetection.ts:23–29](supabase/functions/_shared/oooDetection.ts:23).
A matched SaaS notification calls `applyOOOPause` and pauses the lead
for 7 days when no return date is parseable. Real-world frequency is
unknown — gmail-sync only processes emails to/from the lead's own
address, which mostly insulates against this. Phase 2.5 will scan
recent OOO pauses for senders matching common SaaS-notification
patterns (`@*.salesforce.com`, `@*.zendesk.com`, `@notifications.*`)
before deciding whether to add a from-allowlist exception.

### Outlook Sent Items capture miss
**Scheduled scan: Phase 2.5.**
[EDGE_CASES.md §7](EDGE_CASES.md#7-silent-send-failures-gmail-send--outlook-send).
[outlook-send/index.ts:454](supabase/functions/outlook-send/index.ts:454)
uses `lookupSentMessageId()` to re-fetch the just-sent message from
Sent Items after Microsoft Graph's send response. If the lookup
fails (Graph returns 200 but the message never lands in Sent Items
or the follow-up fetch errors), the interaction row is still written
with `gmail_message_id = null` and only `logger.warn("mail.outlook.sent_items_capture_missed")`
fires. Phase 2.5 will scan 30 days of logs for that warning to size
the problem. If meaningful, follow-up will treat outlook outbound
rows with `null` provider_message_id as "send not confirmed" in the
action queue rather than as a confirmed reply that clears
`needs_action`.

### Stale `hasFutureMeeting` variable in gmail-sync / outlook-sync
**Scheduled fix: Phase 2a.**
[EDGE_CASES.md §1](EDGE_CASES.md#1-detector-disagreement-ooo--meeting-confirmation).
`hasFutureMeeting` is read once at
[gmail-sync/index.ts:224](supabase/functions/gmail-sync/index.ts:224)
and [outlook-sync/index.ts:155](supabase/functions/outlook-sync/index.ts:155)
before the message loop. If a meeting confirmation in the same batch
sets `has_future_meeting=true`, the local variable stays `false` and
the end-of-sync `deriveAction()` is called with the stale value, so
the `pause_when_meeting_scheduled` guard at
[_shared/syncEngine.ts:368](supabase/functions/_shared/syncEngine.ts:368)
does not fire on the run that detected the meeting. Causes a
flickering "Reply Now → goes away on next sync" UX. Two-line fix in
Phase 2a (re-read `has_future_meeting` immediately before the
end-of-sync `deriveAction` call).

### Body-aware meeting detector gap — accepts hide embedded questions
**Scheduled fix: Phase 2a.**
[EDGE_CASES.md §4](EDGE_CASES.md#4-calendar-accept-with-substantive-reply).
`detectMeetingConfirmation()` returns on subject match alone and
never inspects body for embedded substantive content
([_shared/meetingConfirmation.ts:48–57](supabase/functions/_shared/meetingConfirmation.ts:48)).
"Accepted: Demo Thursday — by the way, can you send pricing?" gets
classified as a clean meeting confirmation and the pricing question
disappears from the queue. Phase 2a fix: when `confidence === "subject"`,
also scan body for `?` plus commercial keywords (`pricing`, `price`,
`cost`, `quote`, `proposal`, `contract`, `timeline`, `when`, `how`)
and return a softer result so the meeting handler does not blanket-set
`needs_action=false`.

---

## Action-queue UI gaps

### No "this lead was resurfaced" audit signal
**Scheduled fix: Phase 2a.**
[EDGE_CASES.md §9](EDGE_CASES.md#9-why-is-this-back--surfacing-resurfacing).
[_shared/syncEngine.ts:673–678](supabase/functions/_shared/syncEngine.ts:673)
silently clears `action_dismissed_at` and
`action_permanently_dismissed` whenever a fresh inbound arrives —
no audit-log row, no column stamped, no UI badge. Reps see leads
they dismissed reappear in their queue with no explanation. Phase
2a will add `action_resurfaced_at timestamptz` (or a parallel
`lead_action_events` log table) stamped at the moment the dismissal
clears. UI shows a "↻ Resurfaced 2h ago" pill.

### Inbound-only re-arm decided (May 2026)
**Implementation: Phase 2a.**
Decision: only fresh INBOUND activity should clear a dismissed
action. Today
[_shared/syncEngine.ts:586–600](supabase/functions/_shared/syncEngine.ts:586)
treats `lastInteractionTime = MAX(last_outbound_at, last_inbound_at)`,
which means the rep's own outbound send also re-arms a just-handled
lead. Phase 2a will narrow that comparison to `last_inbound_at` only
(see EDGE_CASES.md §3 caveat for the original framing) so a "mark
handled → I'll follow up" rep flow doesn't immediately yank the lead
back into the queue when the rep sends.

### Timezone rendering of `eligible_at`
**Scheduled for adoption-time: Phase 2a.**
[EDGE_CASES.md §11](EDGE_CASES.md#11-time-zones--eligible_at-rendering).
Today nothing in the UI renders `eligible_at` as a user-visible
time, so there is no current bug. When the queue page starts showing
"Eligible at 9:30 AM" or "Fires in 3h", the formatter must read
workspace timezone from
[`workspaces.timezone`](supabase/migrations/20260430200000_workspace_timezone.sql)
via `WorkspaceContext` rather than defaulting to browser TZ. Track
as a precondition on the Phase 2a queue page work.

---

## Lead Detail tab retirement (decided May 2026)

**Scheduled: Phase 3.**
Upload and Deep Analysis tabs on `/app/leads/:id` retire in Phase 3.
Specific commitments:
- **Deal Factors** card (currently the only unique content of
  `RecommendationsTab.tsx`) moves into `UnifiedIntelligenceCard` as
  an expandable section.
- **Upload tab**'s "paste an interaction" form becomes
  `TimelineTab`'s "Add Interaction" affordance.
- **`annotateInteractionAI`** helper in `src/lib/supabaseQueries.ts`
  is consumed only by Upload tab — becomes a deletion candidate.
- **`lead_deep_analysis`** `ai_task` task is called only from Upload
  tab — also a deletion candidate once the meeting pipeline migrates
  to `recompute-lead-intelligence`.
- **Milestone-checkbox UI** currently duplicated between
  `RecommendationsTab.tsx` and `MeetingsTab.tsx` (both call
  `updateLeadMilestoneStatus`) consolidates to one implementation.

---

## Open research

### Rep behaviour questions (pending answers)
Two open questions block confident Phase 2a sizing:
1. **Off-platform reply frequency** — how often do reps reply via
   channels that don't sync back into DrivePilot (dictated to an
   assistant, WhatsApp from phone, etc.)? Affects how aggressive the
   action queue should be about clearing stale `needs_action` rows.
2. **Typical book size** — distribution of active vs. in-automation
   leads per rep. Informs pagination defaults and the queue page's
   "show more" thresholds. Today
   [LeadTable.tsx:304](src/components/dashboard/LeadTable.tsx:304)
   hard-codes `PAGE_SIZE = 25`; the new queue should pick a default
   grounded in real distributions.
