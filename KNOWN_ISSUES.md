# KNOWN_ISSUES.md

Living list of issues we've decided to defer, with the phase or PR
where each is scheduled to be addressed. Entries link back to the
audit docs ([AUDIT.md](AUDIT.md), [EDGE_CASES.md](EDGE_CASES.md),
[BULK_OPS_INVENTORY.md](BULK_OPS_INVENTORY.md)) for context.

Phases referenced here are the action-queue redesign rollout:
- **Phase 1** — schema + backfill + dead-code cleanup (current).
- **Phase 1.5** — bulk-move-to-nurture guardrail (ships immediately after Phase 1).
- **Phase 1.6** — close the executor consent-gate race surfaced by Codex on PR #40.
- **Phase 2a** — sync-path detector wiring, classifier, UI for new column.
- **Phase 2b** — Lead List bulk-mover redesign.
- **Phase 2.5** — runtime scans to size deferred risks.
- **Phase 3** — Lead Detail tab retirement.

---

## Edge function config.toml registration

**Status: closed by Phase 1.5.**

When a new edge function is added under `supabase/functions/<name>/`,
its source alone is not enough — `supabase/config.toml` must also
contain a `[functions.<name>]` block (typically with
`verify_jwt = false` for functions that authenticate via
`requireScheduledCaller` / `X-Internal-Secret` / service-role rather
than user JWT). Without that block, Lovable does not auto-deploy the
function on merge and the documented invocation paths silently fail.

History:
- **PR #38** landed `classify-timeline-intent-backfill` without its
  config.toml entry, requiring a separate manual deployment. The
  X-Internal-Secret invocation path documented in PR #38's operator
  runbook was broken until Phase 1.5 backfilled the registration;
  service-role JWT invocation still worked because Supabase's gateway
  validates service-role tokens even when `verify_jwt` defaults to
  true.
- **PR #39 / #41** added `classify-timeline-intent-sample` with its
  registration in the same PR — the correct pattern. (PR #39 itself
  merged into a stale base branch; PR #41 re-landed the same commit
  against main — see the "Stacked PR retarget discipline" note in
  memory.)
- **Phase 1.5** added the missing `classify-timeline-intent-backfill`
  registration alongside the bulk-move-to-nurture guardrail work.

**Going forward:** every PR that adds a new edge function MUST include
the corresponding `[functions.<name>]` block in `supabase/config.toml`
in the same PR. This is a hard requirement, not a follow-up.

---

## automation-executor consent-gate race against in-flight mutations

**Scheduled fix: Phase 1.6.**

Surfaced by Codex on [PR #40](https://github.com/sbenchmuel-sys/leadrocketai/pull/40)
in the review of commit `47dbd887`. The Phase 1.5 bulk-move-to-nurture
dialog clears `automation_mode` on BLOCKED leads in the same UPDATE as
the motion flip, but that mitigation does not close the race window
inside `automation-executor`'s send loop:

1. **Candidate query** ([automation-executor/index.ts:253](supabase/functions/automation-executor/index.ts#L253))
   gates on `automation_mode IS NOT NULL` and pulls the eligible lead
   set for the tick.
2. **Safety refetch** ([automation-executor/index.ts:408–413](supabase/functions/automation-executor/index.ts#L408))
   re-reads each lead before sending — but the SELECT list is
   `last_inbound_at, last_outbound_at, has_future_meeting, motion,
   stage, needs_action, eligible_at, status, unsubscribed`. It does
   **NOT** include `automation_mode`, so a consent-withdrawal that
   landed since the candidate query is invisible.
3. **Multi-await window** between refetch and provider send: stop-
   conditions check, multi-participant guard (one query for the last
   inbound), min-gap check, per-lead caps check (own queries), draft
   lookup/generation (calls `ai_task` over HTTP — multiple seconds),
   claim insert, then `gmail-send` / `outlook-send` / `sms-send`.

If a bulk-move-to-nurture (or any other path that nulls
`automation_mode`) lands inside that window, the executor still has a
stale snapshot of consent and sends one stale outbound. Phase 1.5
narrows the warning gap to zero but does not close this race window.

**Phase 1.6 fix (small):**
- Add `automation_mode` to the safety-refetch SELECT.
- After the refetch, if `freshLead.automation_mode == null` (or if
  `freshLead.motion === 'nurture'`), mark the `automation_log` row
  status `"skipped"` with `error_message="Consent withdrawn or motion
  changed mid-flight"` and `continue` before the send call.
- Telemetry: count these skips so we can size how often the race
  actually fires in production.

**Why now (Phase 1.6) and not in Phase 1.5:** scope discipline. Phase
1.5's mandate was the bulk-move dialog and audit trail; editing
automation-executor's hot path is a separate concern with its own
review surface area. Phase 1.5 ships as a strict improvement over the
silent clobbering it replaces; Phase 1.6 is a small focused PR
touching only the executor.

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
**Status: closed by Phase 1.5.**
[BULK_OPS_INVENTORY.md §B2](BULK_OPS_INVENTORY.md#b2-bulk-move-to-nurture).
Originally: "Move to Nurture" in `LeadTable.tsx` updated `motion`,
`nurture_status`, `nurture_mode`, `nurture_cadence`, `next_action_key`,
`eligible_at`, `action_reason_code`, and `mode_changed_at` on every
selected lead with no eligibility check or warning — leads already
running an outbound sequence got clobbered mid-flight and the customer
saw half a sequence followed by a nurture switch.

Phase 1.5 introduced `categorizeForNurtureMove()` in
[src/lib/leadEligibility.ts](src/lib/leadEligibility.ts) (modelled on
`BulkAutomationDialog`'s `categorizeLead()` flag pattern) and replaced
the inline `AlertDialog` with `<BulkMoveToNurtureDialog>` which surfaces
the ELIGIBLE/BLOCKED partition and gives the rep three actions:
**Move all** (also clears `automation_mode` on BLOCKED leads to halt
the executor), **Move only the N eligible** (skips BLOCKED leads),
or **Cancel**. Every affected lead gets an `insertSystemNote()`
audit row recording the action and the rep who took it.

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

### `intent_router` writes a granular vocabulary not in the migration's documented list
**Scheduled reconciliation: Phase 2a follow-up.**
[20260520120000_lead_timeline_items_intent.sql](supabase/migrations/20260520120000_lead_timeline_items_intent.sql)
documents the column's allowed values as
`human_reply, calendar_accept, calendar_invite, meeting_confirmation,
zoom_recap, ooo_reply, bounce, unsubscribe, defer_request,
manual_handled, unknown`. The Phase 2a AI cron
([classify-inbound/index.ts](supabase/functions/classify-inbound/index.ts))
writes the `intent_router` prompt's own vocabulary instead:
`book_meeting, pricing, technical_sdk, security_privacy,
legal_procurement, partnership, support, not_sure` — i.e. it
sub-classifies what the migration calls `human_reply` rather than
writing the bucket label. The column has no CHECK constraint yet, so
this is currently a documentation gap, not a runtime error. Two
follow-ups need to land together before a CHECK can be added:
- Decide whether the column stores the bucket (`human_reply`) with
  the sub-intent in `status_json.ai_intent`, or stores the granular
  value directly (current behaviour). Queue UI filtering
  (AUDIT.md "Hide rows whose latest inbound has `intent IN
  ('calendar_accept', 'ooo_reply', 'bounce', 'zoom_recap')`")
  works either way today because the granular values aren't in the
  hide-list, but downstream consumers need a single answer.
- Once decided, update the migration comment, then add a CHECK
  constraint that covers both heuristic and AI vocabularies.

### `intent_router` does not return a confidence score
**Scheduled enhancement: Phase 2a follow-up.**
The PR brief for [classify-inbound/index.ts](supabase/functions/classify-inbound/index.ts)
specified a "low confidence → write NULL" branch, conditional on the
classifier returning a confidence score. The current `intent_router`
prompt in [_shared/prompts.ts](supabase/functions/_shared/prompts.ts)
returns `intent_primary, urgency, reply_worthy, suggested_motion,
questions_extracted, tone` — no `confidence`. The cron therefore
reduces the brief's threshold check to "JSON parse failed or
out-of-vocab intent → leave NULL for a retry." When the prompt is
updated to return a confidence score, add a numeric threshold check
in `classify-inbound` ahead of the UPDATE and route low-confidence
results through the same NULL path; a `confidence` column on
`lead_timeline_items` is deliberately deferred until the prompt
actually returns one.

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
