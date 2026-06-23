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

## Manager team-view on the Leads page

**Status: parked — requires a Tier-1 RLS change. Do not attempt an app-only fix.**

Manager team-view on the Leads page is parked. The leads SELECT RLS policy is
owner-scoped (is_workspace_admin = admin only), so managers are restricted to
their own leads at the database level regardless of app code. The Unit A
app-level manager-scope logic is currently a no-op. To genuinely give managers
a team view requires a Tier-1 RLS change plus a DB-readable definition of a
manager's team (reuse Manager Analytics' scoping). Do not attempt an app-only
fix.

The dead app-level manager exemption has since been reverted so the app filter
honestly matches the database rule: non-admins (reps and managers) get
own-leads-only; admins unchanged.

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

**Status: closed by Phase 1.6 ([PR #47](https://github.com/sbenchmuel-sys/leadrocketai/pull/47)).**

Originally surfaced by Codex on
[PR #40](https://github.com/sbenchmuel-sys/leadrocketai/pull/40)
in the review of commit `47dbd887`. Phase 1.5's bulk-move-to-nurture
dialog clears `automation_mode` on BLOCKED leads in the same UPDATE
as the motion flip, but that mitigation did not close the race window
inside `automation-executor`'s send loop:

1. **Candidate query** ([automation-executor/index.ts:253](supabase/functions/automation-executor/index.ts#L253))
   gates on `automation_mode IS NOT NULL` and pulls the eligible lead
   set for the tick.
2. **Safety refetch** ([automation-executor/index.ts:408–413](supabase/functions/automation-executor/index.ts#L408))
   re-read each lead before sending — but the original SELECT list
   (`last_inbound_at, last_outbound_at, has_future_meeting, motion,
   stage, needs_action, eligible_at, status, unsubscribed`) did
   **NOT** include `automation_mode`, so a consent withdrawal that
   landed since the candidate query was invisible.
3. **Multi-await window** between refetch and provider send: stop-
   conditions check, multi-participant guard (one query for the last
   inbound), min-gap check, per-lead caps check (own queries), draft
   lookup/generation (calls `ai_task` over HTTP — multiple seconds),
   claim insert, then `gmail-send` / `outlook-send` / `sms-send`.

If a bulk-move-to-nurture (or any other path that nulled
`automation_mode`) landed inside that window, the executor still had
a stale snapshot of consent and sent one stale outbound. Phase 1.5
narrowed the warning gap to zero but did not close this race window.

**Phase 1.6 fix (shipped):**
- `automation_mode` (and `workspace_id` for telemetry correlation) added
  to the safety-refetch SELECT.
- **Two layered consent-gate race guards**, both gating on
  `automation_mode IS NULL` alone (see correction note below):
  - **Early guard** placed AFTER the safety refetch and BEFORE the
    multi-await chain (stop-condition / multi-participant / min-gap /
    caps / draft fetch / `ai_task` HTTP roundtrip). This is the cheap
    path — bails before spending `ai_task` tokens on an already-
    withdrawn lead.
  - **Late guard** placed AFTER the pre-send claim insert and
    IMMEDIATELY BEFORE the provider fetch (`gmail-send` /
    `outlook-send` / `sms-send`). This is the true race closer — the
    window between the early guard and the late guard covers the
    full multi-second await chain, which is where withdrawals can
    actually land. The late guard does a minimal
    `SELECT automation_mode` and shrinks the remaining race window to
    a single network roundtrip to the provider. On skip it UPDATEs
    the claim row by `claimId` to `status="skipped"` (mirroring the
    existing SMS-no-phone post-claim skip pattern); fail-closed if
    the lookup itself errors.
- On either guard firing, the `automation_log` row is written with
  `status="skipped"` and `error_message="Consent withdrawn mid-flight"`,
  then `continue` (per-lead skip — one withdrawal does not abort the
  tick).
- Telemetry: both guards emit the same structured INFO log line
  `automation.skipped_consent_race { lead_id, workspace_id }` via the
  shared `logger` helper (intentionally indistinguishable in production
  logs — operators do not need to tell them apart to grep counts).

**Correction during review (Codex P1 on PR #47):** the original Phase
1.6 brief included `freshLead.motion === "nurture"` as a second trigger
for both guards. That was wrong: a `motion === "nurture"` lead with
`nurture_mode === "automatic"` is a legitimate auto-send path, and is
gated downstream at the existing `lead.nurture_mode !== "automatic"`
review-mode check — not by consent. Bulk-move-to-nurture additionally
clears `automation_mode` in the same UPDATE as the motion flip
(Phase 1.5), so the consent withdrawal is visible through that one
column regardless of the motion. The shipped guards therefore rely on
`automation_mode IS NULL` alone; motion is orthogonal to consent.

**Why Phase 1.6 and not Phase 1.5:** scope discipline. Phase 1.5's
mandate was the bulk-move dialog and audit trail; editing
automation-executor's hot path is a separate concern with its own
review surface area. Phase 1.5 shipped as a strict improvement over
the silent clobbering it replaced; Phase 1.6 is the small focused PR
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
**Status: closed by Phase 2a (PR B).**
[EDGE_CASES.md §1](EDGE_CASES.md#1-detector-disagreement-ooo--meeting-confirmation).
PR B inserts a fresh `SELECT has_future_meeting` immediately before
the end-of-sync `deriveAction()` call in both
[gmail-sync/index.ts](supabase/functions/gmail-sync/index.ts) and
[outlook-sync/index.ts](supabase/functions/outlook-sync/index.ts).
`gmail-bulk-sync` was deliberately left untouched — it uses its own
local `deriveAction` (line 224) rather than the shared one, and lives
in a separate hot path that PR B was not chartered to refactor.

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
**Status: closed by Phase 2a (PR B).**
[EDGE_CASES.md §4](EDGE_CASES.md#4-calendar-accept-with-substantive-reply).
`detectMeetingConfirmation()` now returns
`hasSubstantiveQuestion: true` + `matchedKeywords: string[]` when the
subject matches a calendar-accept pattern AND the body contains both
`?` and any keyword from the exported `MEETING_OVERRIDE_KEYWORDS`
constant in [_shared/meetingConfirmation.ts](supabase/functions/_shared/meetingConfirmation.ts).
The four callers (gmail-sync, outlook-sync, gmail-bulk-sync ×2,
outlook-webhook) keep `has_future_meeting=true` but skip the
`needs_action=false` write when the override fires, and write a
distinct `system_note` row noting the matched keywords for audit.

### Voice call deriveAction is a no-op until calls write to `interactions`
**Status: closed by Phase 2a (PR C.5).**
[twilio-voice-webhook/index.ts](supabase/functions/twilio-voice-webhook/index.ts)
now writes an `interactions` row on every `completed` outbound call,
immediately before invoking `postSendDeriveAction`. Row shape mirrors
sms-send's outbound interaction (type=`voice_outbound`, source=`voice`,
direction=`outbound`, from/to_email reused for phone numbers,
dedupe_key=`voice:outbound:<call_session_id>`). The insert uses
`upsert(..., { onConflict: "dedupe_key", ignoreDuplicates: true })` so
re-fired Twilio status callbacks on the same CallSid no-op on the
existing unique partial index. The broader Option B (migrating
`computeMetricsFromInteractions` to read from `lead_timeline_items`)
remains deferred to the `interactions → lead_timeline_items` cleanup.

### Permanent dismiss without snooze is a re-arm trap
**Status: closed by PR D.** PR C's `mark_action_handled` RPC
([20260521010000_mark_action_handled.sql](supabase/migrations/20260521010000_mark_action_handled.sql))
always stamps `action_dismissed_at = now()` even when
`p_permanent=true`. PR D migrated the LIVE callers of
`setLeadPermanentDismiss` to `markActionHandled` /
`undoMarkActionHandled`:

| Migrated call site | Before | After |
|---|---|---|
| `src/components/dashboard/PriorityActions.tsx` (Dismiss dropdown + Undo) | `setLeadPermanentDismiss(id, true)` / `setLeadPermanentDismiss(id, false, snapshot)` | `markActionHandled(id, { permanent: true })` / `undoMarkActionHandled(id, snapshot)` |
| `src/pages/Queue.tsx` (Mark as handled + Undo) | n/a — new surface | `markActionHandled(id, { permanent: true })` / `undoMarkActionHandled(id, snapshot)` |

`setLeadPermanentDismiss` itself is now `@deprecated` in
[supabaseQueries.ts](src/lib/supabaseQueries.ts). The only remaining
caller is the dead-code `ActionRequiredPanel.tsx`, which is not
imported anywhere (verified per AUDIT.md §B1) and is slated for
Phase 3 deletion together with the function.

### Legacy `dismissLeadAction` callers preserved intentionally (PR D)
**Status: documented, not a bug.**
PR D's hard constraint says "no new callers of `dismissLeadAction`"
for **rep-is-dismissing** semantics, but `dismissLeadAction` is also
the canonical wrapper for **N-day snooze** (sets
`action_dismissed_at = now() + N days`). `markActionHandled` only
supports `action_dismissed_at = now()`, so snooze paths cannot use
it. Live callers retained after PR D:

- `PriorityActions.tsx:100` — snooze 1 / 3 / 7 days from the
  dashboard X-overflow menu.
- `Queue.tsx` (handleSnooze) — snooze 3 / 5 / 7 days from the
  Queue card's `[Snooze ▾]` dropdown.
- `EmailActionDialog.tsx:814` — 1-day snooze after the rep clicks
  "Open in Gmail" on a post-meeting recap. The Gmail-compose flow
  may not result in a send; the short snooze gives the rep room to
  finish before the action resurfaces.

Dead-code caller (not imported anywhere, slated for Phase 3 delete):
- `ActionRequiredPanel.tsx:43`.

If we ever want a unified atomic snooze, the right move is to extend
`mark_action_handled` with a `p_snooze_interval interval` argument
and migrate all three live callers together. Out of scope for PR D.

---

## Action-queue UI gaps

### No "this lead was resurfaced" audit signal
**Status: closed by Phase 2a (PR B).**
[EDGE_CASES.md §9](EDGE_CASES.md#9-why-is-this-back--surfacing-resurfacing).
PR B adds `leads.action_resurfaced_at timestamptz` (migration
`20260521000000_add_action_resurfaced_at`) and stamps it in the
SAME UPDATE that clears `action_dismissed_at` /
`action_permanently_dismissed` in
[_shared/syncEngine.ts buildLeadUpdate](supabase/functions/_shared/syncEngine.ts).
Atomicity prevents a transient "cleared but not resurfaced" window.
The Queue UI (PR D) reads this for the "↻ Resurfaced" pill — no
consumer wired up yet in PR B.

### Inbound-only re-arm decided (May 2026)
**Status: closed by Phase 2a (PR B).**
PR B narrows the re-arm comparison in
[_shared/syncEngine.ts buildLeadUpdate](supabase/functions/_shared/syncEngine.ts)
from `lastInteractionTime = MAX(last_outbound_at, last_inbound_at)`
to `lastInboundTime = last_inbound_at`. A rep's own outbound no
longer re-arms a just-handled lead. The dismissal-clear path now
fires only when `lastInboundTime > dismissedAt`, and stamps
`action_resurfaced_at` in the same UPDATE for audit.

### Timezone rendering of `eligible_at`
**Status: closed by PR C.**
PR C lands the [eligibleAtFormat.ts](src/lib/eligibleAtFormat.ts)
helpers (`formatEligibleAtAbsolute`, `formatEligibleAtRelative`,
`formatEligibleAt`) and exposes `workspace_timezone` via
[WorkspaceContext](src/contexts/WorkspaceContext.tsx). The formatter
uses `Intl.DateTimeFormat` with an explicit `timeZone` option so
absolute renders convert UTC `eligible_at` to workspace wall-clock;
NULL workspace TZ falls back to UTC (not browser TZ). Test coverage
in [eligibleAtFormat.test.ts](src/lib/eligibleAtFormat.test.ts).
PR D's Queue UI will consume these helpers.

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

## `ai_summary` durability gaps (post-Phase 2a write-and-fallback)

### Pre-PR historical rows past 72h have header-only reply context
**Status: documented, no fix planned.**
The `ai_summary` write path was added by the `ai_summary_write_and_fallback`
PR (Phase 2a follow-up). For inbound emails that arrived BEFORE that PR
shipped AND whose `snippet_text` has since been purged by the original
72h cron, there is no durable body signal in `metadata_json`. Reply
drafting for those threads falls back to subject + participants + intent
classification only. Going-forward inbounds populate `ai_summary` before
the 72h purge (via the new classification-gated purge), so this is a
strictly historical gap that drains naturally as those threads age out
of relevance.

### v1-classified rows are stuck without `ai_summary`
**Status: documented, no auto-fix planned.**
Rows classified under `intent_version = 'intent_router/v1'` (~322
legacy rows pre-Phase 2a plus any classified in the brief window between
v1 deploy and v2 deploy) have `intent` set but no `ai_summary` in
`metadata_json`. They are NOT auto-re-classified by the cron — the
candidate query gates on `intent IS NULL`, so a row with v1 intent is
considered "done" and stays v1 indefinitely. The read fallback in
[build-lead-context/index.ts:181](supabase/functions/build-lead-context/index.ts)
and [ai_task/index.ts:703](supabase/functions/ai_task/index.ts) handles
the missing `ai_summary` gracefully (falls through to `snippet_text`,
which is itself null past 72h — so context degrades to subject/headers
for v1 rows whose bodies have purged).

A targeted re-classification path is possible (clear `intent` on v1
rows where `snippet_text` is still non-null and bump them through the
v2 cron), but is deliberately deferred — the population is small and
aging, and reclassifying carries a non-zero risk of changing the intent
value, which would ripple into queue filtering decisions reps may have
already taken action on.

### PII handling in `ai_summary` is best-effort, not guaranteed
**Status: documented.**
The v2 `intent_router` prompt instructs the model to omit personal
identifiers (SSN, financial account numbers, passwords, API keys) from
`ai_summary` even when present in the source email. Real-world enterprise
sales emails rarely contain these, but the rule is a soft guard, not a
guarantee. If a customer-side leak surfaces an identifier into a sales
thread, the model could echo it into `ai_summary` and the summary then
survives the 72h body purge. If we ever see this in practice, the right
fix is a post-classification redaction pass (regex strip of the obvious
patterns), not a tighter prompt — the model is not reliable here.

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

---

## Inbound unsubscribe detection — quoted-thread false positive (FIXED 2026-06-08)

**Status: root cause fixed in code; one-off data remediation pending.**

A lead promoted from Pending Leads (Ryan Frankel,
rfrankel@researchoninvestment.com, an **Outlook** workspace) was wrongly
auto-flagged `unsubscribed=true` after a manual sync. Root cause: inbound
unsubscribe detection ran its keyword regex over the FULL plain-text body
**including quoted thread history**. The reply quoted DrivePilot's own pitch
line — "…so you **stop emailing** people who already wrote back" — which
matched `\bstop\s+emailing\b`. HTML→text conversion (`htmlToPlainText`)
discards `<blockquote>`/`>` prefixes, so the quoted text was indistinguishable
from freshly-typed text.

**Fix:** new `stripQuotedReply()` in
`supabase/functions/_shared/unsubscribeDetection.ts` removes quoted reply /
forwarded history (Gmail "On … wrote:" attribution, Outlook
"-----Original Message-----" + From:/Sent:/To:/Subject: header block, `>`
plain-text quotes) before matching. Applied at all THREE detector call sites:
`outlook-sync/index.ts` (narrow inline regex, kept), `gmail-sync/index.ts` and
`outlook-webhook/processor.ts` (shared `isHumanUnsubscribeRequest`). Contract
encoded in `_shared/unsubscribeDetection.test.ts`.

**Guardrail / safety direction:** stripping errs toward fewer detections — if
the sender typed nothing above the quote, `stripQuotedReply` returns "" and no
opt-out fires. A bottom-posted opt-out *below* a quote is a tolerated
false-negative (the inbound stays visible to the rep) because a false
unsubscribe silently kills automation, which is the worse failure.

**Pending:** run `remediation_clear_false_unsubscribe_ryan.sql` (data fix,
not a migration) to re-arm the lead and delete the spurious "Lead requested to
unsubscribe…" system note. Requires DB access — hand to Lovable or run in the
Supabase SQL editor. Needs ai_task/sync edge functions redeployed for the code
fix to take effect.

---

## KB is user-scoped, not workspace-scoped (Outreach KB grounding)

**Status: deferred (founder-approved 2026-06-10).** Tracked here so it doesn't
drop. Surfaced by Codex P1 on PR #75 (Unit A) and underlies PR #78 (Unit B).

`kb_chunks` is keyed by `owner_user_id` only — there is **no `workspace_id`
column** on `kb_chunks` and **no workspace parameter** on the canonical
`match_knowledge_chunks_v2` RPC. A campaign belongs to a workspace, but KB
belongs to a *user*, and a user can be a member of more than one workspace. So
"all of a user's KB" can span workspaces.

Consequences in the shipped Outreach KB work:
- **Unit A (PR #75, doc-less authoring fallback):** the `workspace_fallback`
  (draft from the rep's own KB when a campaign has no uploaded doc) is gated to
  fire **only when the authoring user belongs to exactly one workspace** — then
  their KB is unambiguously that single workspace's. **Multi-workspace authors
  fail closed to no KB search** (the prior thin-copy behavior). They get no
  grounded fallback today.
- **Unit B (PR #78, live-send campaign doc):** scoping to a validated campaign
  document is exact (the document filter restricts to that doc's chunks, and the
  doc owner is verified a member of the campaign's workspace), so it is not
  affected. Only the *doc-less* fallback inherits the limitation above.

**Proper fix (deferred — separate unit, migration/RLS blast radius):** add a
`workspace_id` to the knowledge store (`kb_chunks`) + backfill + a workspace
filter on `match_knowledge_chunks_v2`, then scope all KB retrieval (authoring,
live send, **and** cold outbound — which has the same user-scoped behavior
today) by workspace. This would let multi-workspace reps also get a grounded
doc-less fallback and make every KB read workspace-exact. Not scheduled.
