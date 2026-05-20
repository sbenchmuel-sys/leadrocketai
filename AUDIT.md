# AUDIT.md — Action-item queue feasibility audit

Date: 2026-05-20. Read-only audit; no code was changed.

Scope: figure out what DrivePilot already has that could power a clean
action-item queue, what genuinely needs to be built, and where the existing UI
already covers the surface.

---

## TL;DR

- The canonical comms ledger (`lead_timeline_items`) is well-populated and
  classified by **channel/direction/event_type**, but it has **no intent /
  category / classification column**. Calendar invites, meeting confirmations,
  Zoom recap emails and OOO replies are detected during sync — but the
  detection mutates `leads.*` flags + writes a `system_note`, and **does not
  tag the originating timeline row itself**. So you cannot query the timeline
  for "real human replies vs. bots" — the signal is implicit, not stored.
- "Needs a reply" **is stored**, on the `leads` table
  (`needs_action`, `next_action_key`, `next_action_label`, `eligible_at`,
  `action_reason_code`), and it is **event-driven** — recomputed by
  `syncEngine.deriveAction()` on Gmail/Outlook sync and on
  automation-executor runs. It is **not** recomputed on every page load.
- A queue UI already exists (`PriorityActions.tsx`) but is limited to 3–5
  rows and is tightly coupled to the Dashboard layout. A larger, dedicated
  action-item view does not exist.
- Several intelligence outputs (`recompute-lead-intelligence`,
  `build-lead-context`, `promote-winning-interactions`, conversation
  analysis) already produce signals we'd want in an action queue, but their
  outputs land in different tables — there is no single "action item" table.
- A meaningful amount of older dashboard UI (`AIActivityFeed`,
  `ActionRequiredPanel`, `AIRecommendation`, `SummaryCards`, `DealFlowBar`,
  `FilterBar`, `StageFilterBar`, `IntelligenceCards`) is **not imported
  anywhere** and is effectively dead.

---

# PART A — Action items & timeline data

## A1. `lead_timeline_items` — schema and writers

### Schema

Canonical migration: [supabase/migrations/20260324154224_5c08870b-2f6c-49b1-8d26-ed8ff3e614f7.sql](supabase/migrations/20260324154224_5c08870b-2f6c-49b1-8d26-ed8ff3e614f7.sql)

Columns:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid NOT NULL | RLS anchor |
| `lead_id` | uuid NOT NULL, ON DELETE CASCADE | |
| `contact_id` | uuid | nullable |
| `conversation_id` | uuid | nullable |
| `channel` | text NOT NULL | `email`, `whatsapp`, `voice`, `meeting`, `system`, `sms` |
| `provider` | text | `gmail`, `outlook`, `meta`, `twilio`, `zoom`, `manual`, `automation`, `google_meet`, `microsoft_teams` |
| `direction` | text | `inbound`, `outbound`, NULL for meetings/notes |
| `event_type` | text NOT NULL | `email_inbound`, `email_outbound`, `whatsapp_inbound`, `whatsapp_outbound`, `sms_inbound`, `sms_outbound`, `phone_call`, `call_completed`, `meeting`, `meeting_transcript_captured`, `note`, `system_note` |
| `occurred_at` | timestamptz NOT NULL | |
| `source_table` | text NOT NULL | `interactions`, `call_sessions`, `meeting_summaries`, `meeting_transcripts`, `messages` |
| `source_id` | text NOT NULL | UUID-as-text from source table; **no FK enforced** |
| `snippet_text` | text | First ~500 chars of body or summary |
| `subject` | text | |
| `status_json` | jsonb DEFAULT `'{}'` | `{hidden, ai_reply_worthy, ai_intent}` |
| `metadata_json` | jsonb DEFAULT `'{}'` | channel-specific (gmail_message_id, gmail_thread_id, conversation_id, call_session_id, ai_summary, participants, …) |
| `dedupe_key` | text NOT NULL | idempotency anchor |
| `created_at` / `updated_at` | timestamptz | |

Unique constraint: `(lead_id, dedupe_key)`. All writers upsert on this.

**There is no `intent`, `category`, `classification`, `is_calendar`,
`is_auto_reply`, `is_bounce`, or `email_type` column.** The closest is
`status_json.ai_reply_worthy` (a single boolean) and `status_json.ai_intent`
(set only by client-side AI annotation; see A1.10 below).

### Full list of writers

Order: roughly inbound mail → outbound mail → SMS → WhatsApp → voice → meetings → system.

| # | File | Lines | event_type(s) | channel | source_table |
|---|---|---|---|---|---|
| 1 | [supabase/functions/gmail-sync/index.ts](supabase/functions/gmail-sync/index.ts) | 411, 468, 521, 533 | `email_inbound`, `email_outbound`, `system_note` | email/system | interactions |
| 2 | [supabase/functions/gmail-bulk-sync/index.ts](supabase/functions/gmail-bulk-sync/index.ts) | 470, 522, 533, 682, 690 | same | email/system | interactions |
| 3 | [supabase/functions/outlook-sync/index.ts](supabase/functions/outlook-sync/index.ts) | 297, 350, 395, 407 | same | email/system | interactions |
| 4 | [supabase/functions/outlook-webhook/processor.ts](supabase/functions/outlook-webhook/processor.ts) | 412, 503, 535, 548 | `email_inbound`, `system_note` | email/system | interactions |
| 5 | [supabase/functions/gmail-send/index.ts](supabase/functions/gmail-send/index.ts) | 348 | `email_outbound` | email | interactions |
| 6 | [supabase/functions/outlook-send/index.ts](supabase/functions/outlook-send/index.ts) | 502 | `email_outbound` | email | interactions |
| 7 | [supabase/functions/sms-webhook/index.ts](supabase/functions/sms-webhook/index.ts) | 172 | `sms_inbound` | sms | interactions |
| 8 | [supabase/functions/sms-send/index.ts](supabase/functions/sms-send/index.ts) | 209 | `sms_outbound` | sms | interactions |
| 9 | [supabase/functions/whatsapp-events-processor/index.ts](supabase/functions/whatsapp-events-processor/index.ts) | 456 | `whatsapp_inbound` | whatsapp | interactions |
| 10 | [supabase/functions/whatsapp-send/index.ts](supabase/functions/whatsapp-send/index.ts) | 204 | `whatsapp_outbound` | whatsapp | interactions |
| 11 | [supabase/functions/twilio-voice-webhook/index.ts](supabase/functions/twilio-voice-webhook/index.ts) | 238 | `call_<status>` | voice | call_sessions |
| 12 | [supabase/functions/call-analyze/index.ts](supabase/functions/call-analyze/index.ts) | 515 | `phone_call` | voice | call_sessions |
| 13 | [supabase/functions/process-zoom-summary/index.ts](supabase/functions/process-zoom-summary/index.ts) | 665 | `meeting` | meeting | meeting_summaries |
| 14 | [supabase/functions/meet-transcript-fetch/index.ts](supabase/functions/meet-transcript-fetch/index.ts) | 415 | `meeting_transcript_captured` | meeting | meeting_transcripts |
| 15 | [supabase/functions/teams-transcript-fetch/index.ts](supabase/functions/teams-transcript-fetch/index.ts) | 346 | `meeting_transcript_captured` | meeting | meeting_transcripts |
| 16 | [supabase/functions/meeting-transcript-analyze/index.ts](supabase/functions/meeting-transcript-analyze/index.ts) | 302 | `meeting_transcript_captured` (upsert) | meeting | meeting_transcripts |
| 17 | [supabase/functions/_shared/oooPauseActions.ts](supabase/functions/_shared/oooPauseActions.ts) | 62, 134 | `system_note` | system | — |
| 18 | [src/lib/supabaseQueries.ts](src/lib/supabaseQueries.ts) | 853–959 | `email_*`/`whatsapp_*`/`sms_*`/`system_note` | inferred | interactions |
| 19 | [src/lib/supabaseQueries.ts](src/lib/supabaseQueries.ts) | 966–980 | `system_note` | system | interactions |
| 20 | [src/lib/supabaseQueries.ts](src/lib/supabaseQueries.ts) | 1011–1075 | (UPDATE only) — sets `status_json.ai_reply_worthy`, `metadata_json.ai_summary`, `metadata_json.ai_intent` | — | — |
| 21 | [src/lib/timelineDriftAudit.ts](src/lib/timelineDriftAudit.ts) | 288–290 | backfill from legacy `interactions` | (inferred) | interactions |

Server writers funnel through `createCanonicalInteraction()` and
`projectTimelineItem()` in `supabase/functions/_shared/` (see
[timelineProjection.ts](src/lib/timelineProjection.ts) for the client-side
mirror).

### Dedupe key formats

| Source | Format |
|---|---|
| Gmail | `gmail:<message_id>` |
| Outlook (sync) | `outlook:<internet_message_id>` or `outlook:graph:<id>` |
| Outlook (webhook) | `outlook:webhook:<provider_message_id>` |
| SMS | `twilio:sms:<message_sid>` |
| WhatsApp | `wa:<direction>:<provider_message_id>` |
| Voice call | `call:<call_session_id>` |
| Meeting (Zoom) | `meeting:<meeting_summary_id>` |
| Meeting transcript | `meeting_transcript:<transcript_id>` |
| Legacy interactions | `interaction:<interaction_uuid>` |
| System notes | `<source>:<type>:<lead_id>:<content_fingerprint>` |

### Reads

- [src/lib/supabaseQueries.ts:350–479](src/lib/supabaseQueries.ts) —
  `getLeadTimeline(leadId, options?)` is the canonical reader. It returns all
  columns above plus a merged fallback of orphan `interactions` rows (the
  legacy compatibility shim).
- [src/lib/leadActivity.ts:165–223](src/lib/leadActivity.ts) —
  `getLeadActivityFeed()` normalizes to a unified `LeadActivityItem[]`.
- [src/lib/inboxQueries.ts](src/lib/inboxQueries.ts) — `fetchConversations()`
  groups leads by latest timeline row for the Inbox list.

## A2. Calendar invites, confirmations, OOO, bounces, auto-replies

### What detection exists

| Type | Detector | Where called |
|---|---|---|
| OOO auto-reply | [supabase/functions/_shared/oooDetection.ts:1–179](supabase/functions/_shared/oooDetection.ts) — checks `Auto-Submitted`, `X-Autoreply`, `X-Auto-Response-Suppress`, `Precedence` headers; subject regexes; body phrase counts | gmail-sync:425, outlook-sync:310, outlook-webhook, gmail-bulk-sync:482 |
| Meeting confirmation | [supabase/functions/_shared/meetingConfirmation.ts:1–73](supabase/functions/_shared/meetingConfirmation.ts) — subject prefixes (`Accepted:`, `Tentatively Accepted:`, `Invitation:`) + body phrases (`see you on…`, `confirmed for…`, `looking forward…`, `calendar invite accepted`) | gmail-sync:460, outlook-sync:342 |
| Bounce / NDR | inline rules in gmail-sync:387–397 and outlook-sync:277–287 — from-address (`postmaster`, `mailer-daemon`) + subject (`Delivery Status Notification`, `Undeliverable`, `Mail Delivery Failed`, …) | — |
| Human unsubscribe | [supabase/functions/_shared/unsubscribeDetection.ts:12–31](supabase/functions/_shared/unsubscribeDetection.ts) — phrases like "stop emailing", "remove me", gated by absence of `List-Unsubscribe` header | gmail-sync:506, outlook-sync:384 |
| Defer / "reconnect later" | [supabase/functions/_shared/oooDetection.ts:195–316](supabase/functions/_shared/oooDetection.ts) — human-authored "reach out in Q3", "next quarter", date parsing | gmail-sync, outlook-sync |
| Zoom recap email | [supabase/functions/process-zoom-summary/index.ts:40–67](supabase/functions/process-zoom-summary/index.ts) — from-domain + keyword pairs | gmail-sync:~723 |

### Where the distinction lands — and where it doesn't

- **It does NOT land on the timeline row of the email itself.** The detected
  email is still written as a normal `email_inbound` row in
  `lead_timeline_items` with no flag indicating it was a calendar accept / OOO
  / bounce / Zoom recap.
- **It lands on the `leads` table** via
  [supabase/functions/_shared/oooPauseActions.ts](supabase/functions/_shared/oooPauseActions.ts):
  - OOO → `ooo_until`, `eligible_at`, clear `needs_action`, system note.
  - Bounce → `unsubscribed=true`, `needs_action=false`, `eligible_at=null`,
    `nurture_status='inactive'`, system note.
  - Meeting confirm → `has_future_meeting=true`, system note,
    `captureWinningInteraction()`.
  - Human unsubscribe → `unsubscribed=true`, system note.
  - Defer → `ooo_until`, `eligible_at` pushed forward, `next_step` set,
    system note.
- **It lands as a separate `system_note` row in the timeline** (see writers
  #1–4 and #17). These are queryable but only by parsing snippet text — there
  is no structured "reason_code" column on the system note itself.

### Calendar events as first-class records

[supabase/migrations/20260510000000_add_calendar_events.sql](supabase/migrations/20260510000000_add_calendar_events.sql)
defines `calendar_events` (provider, platform, title, start/end, attendees,
meeting_url, organizer, status). [supabase/functions/calendar-sync/index.ts](supabase/functions/calendar-sync/index.ts)
fetches a 14-day window from Google Calendar and Microsoft Graph and matches
attendees to leads. **No ICS / `text/calendar` parsing from email MIME parts
exists anywhere in the repo.** The signal "calendar invite was sent in email"
is therefore only captured indirectly (via the calendar API), never via the
email pipeline.

### Net effect for an action queue

If you want to suppress calendar accepts, Zoom recaps and OOO replies from a
"needs reply" queue, today you must:

1. Re-run the same regex/header detectors on each row, or
2. Cross-check against the adjacent `system_note` row, or
3. Cross-check against the `leads.has_future_meeting` / `leads.ooo_until` flags
   that those detectors set.

There is no `timeline_item.intent` or `timeline_item.category` column to lean
on. This is the single biggest gap for a clean queue.

## A3. How the app decides a lead "needs a reply"

### Stored, not computed-on-read

The decision lives on `leads`:

- `needs_action` (boolean)
- `next_action_key` (e.g. `reply_now`, `send_pre_2`, `generate_post_meeting_recap`)
- `next_action_label` (human-readable)
- `eligible_at` (timestamptz)
- `action_reason_code` (enum, e.g. `REPLY_PENDING`)
- `action_dismissed_at` (snooze)
- `action_permanently_dismissed` (boolean, added in
  [20260504100001_lead_permanent_dismiss.sql](supabase/migrations/20260504100001_lead_permanent_dismiss.sql))

### The decision engine

[supabase/functions/_shared/syncEngine.ts:346–519](supabase/functions/_shared/syncEngine.ts)
defines `deriveAction(stage, metrics, modeSettings, lead)`.

The "Reply now" branch ([syncEngine.ts:394–407](supabase/functions/_shared/syncEngine.ts:394)):

```
if last_inbound_at > last_outbound_at
  && elapsed > modeSettings.reply_pending_hours * HOUR
  → { needs_action: true, next_action_key: "reply_now",
      next_action_label: "Reply to customer",
      action_reason_code: "REPLY_PENDING" }
```

Thresholds ([syncEngine.ts:107–113](supabase/functions/_shared/syncEngine.ts:107)):

- fast strategy: **4 hours**
- nurture strategy: **24 hours**

The rest of `deriveAction()` handles outbound cadence (`send_pre_2`, etc.),
post-meeting recap prompts, and stage-driven defaults.

### When is it (re)computed?

Only on these triggers:

1. **Inbound email arrival** — `gmail-sync` / `outlook-sync` /
   `outlook-webhook` run `deriveAction()` after every fetch.
2. **Outbound send** — `gmail-send` / `outlook-send` invoke the sync engine
   on success.
3. **Automation tick** — `automation-executor` re-evaluates per-lead before
   firing the next scheduled send.

It is **not** recomputed on dashboard page load, on lead detail view, or on
any client-side mutation. If the rep replies via a non-tracked channel and
no inbound arrives afterward, `needs_action` will stay true until the next
sync catches the outbound.

### Invalidation / clearing

[syncEngine.ts:569–682](supabase/functions/_shared/syncEngine.ts:569)
(`buildLeadUpdate()`) applies these gates before writing back:

- OOO active → suppress action_required
- `action_dismissed_at` in the future → suppress
- `action_permanently_dismissed=true` → suppress
- Active automation running → don't overwrite

A fresh inbound auto-clears both `action_dismissed_at` and
`action_permanently_dismissed` ([syncEngine.ts:673–678](supabase/functions/_shared/syncEngine.ts:673)).

### Dashboard-side classification

[src/lib/dashboardUtils.ts:176–275](src/lib/dashboardUtils.ts:176) defines
`RevenueState` (`action_required`, `heating_up`, `long_cycle`, `nurture`,
`active`, `automation`) and `classifyRevenueState()`. The
`action_required` state ([dashboardUtils.ts:235–249](src/lib/dashboardUtils.ts:235))
ANDs the stored `needs_action` flag with client-side gates (OOO, snooze,
permanent dismiss, recent unanswered outbound).

## A4. What `ai_task` already classifies

[supabase/functions/ai_task/index.ts](supabase/functions/ai_task/index.ts)
(2,581 lines). Task types from
[supabase/functions/_shared/prompts.ts:68](supabase/functions/_shared/prompts.ts:68):

**Inbound classifiers**:
- `intent_router` — single-pass inbound classifier with intents:
  `book_meeting`, `pricing`, `technical_sdk`, `security_privacy`,
  `legal_procurement`, `partnership`, `support`, `not_sure`. Also outputs
  `urgency` and `reply_worthy`.
- `whatsapp_classify_intent` — WhatsApp-channel intent.

**Generative tasks**:
- `email_intro_fast`, `email_intro_nurture`
- `pre_email_1_intro`, `pre_email_2_followup`, `pre_email_3_followup`, `pre_email_4_breakup`
- `inbound_intro`, `inbound_followup_1`, `inbound_followup_2`
- `re_engagement_intro`, `followup_sequence_4`
- `post_meeting_recap`, `post_meeting_followup_personalized`, `post_meeting_followup_email`
- `reply_to_thread`, `answer_questions`, `recommend_next_steps`
- `nurture_sequence`, `nurture_email_single`
- `linkedin_connect`, `linkedin_followup`
- `whatsapp_message`, `whatsapp_reply_suggestion`
- `sms_message`
- `extract_style_features` (writes to `style_examples` directly)

**Important**: `intent_router` is the only task that returns a categorical
intent on an inbound message. It is NOT called automatically on every inbound
during sync — it has to be invoked explicitly by a caller. There is no DB
column that stores the resulting intent on the timeline row. Today, the
`status_json.ai_intent` annotation path
([supabaseQueries.ts:1011–1075](src/lib/supabaseQueries.ts:1011)) is the only
place such a label could be persisted, and it is a one-off client-driven
update — there is no scheduled job that classifies inbounds and writes back.

## A5. What `build-lead-context` returns

File: [supabase/functions/build-lead-context/index.ts](supabase/functions/build-lead-context/index.ts) (356 lines).

Input: `{ lead_id, force? }`.

Returns `{ ok, context, cached }` where `context` is:

```
{
  company_summary,               // string
  lead_role_summary,             // string
  signals: [{type, description, source}],   // from lead_signals
  recommended_angles: [string],  // AI-generated, 3–5 angles
  industry_context,              // from kb_chunks (≤800 chars)
  previous_interactions_summary, // formatted "[DIR] [CHANNEL] …" digest
  lead_context_items: [{category, content_type, content_text, …}],
  deal_continuity: {             // from deal_memory
    momentum_state, unanswered_questions, unresolved_objections,
    continuity_risks, recent_cta_patterns, shared_assets,
    sent_offers, pricing_status, ignored_cta_count
  },
  generated_at
}
```

Cached in `lead_context_cache` for 6h, keyed by `lead_id`.

Consumers:
- [src/lib/generateDraft.ts:601–626](src/lib/generateDraft.ts:601) — blocking
  for first-touch leads; fire-and-forget thereafter.
- [supabase/functions/ai_task/index.ts:1545–1565](supabase/functions/ai_task/index.ts:1545)
  — reads the cached blob and injects angles, summaries and context items
  into draft prompts.

## A6. What `recompute-lead-intelligence` computes

File: [supabase/functions/recompute-lead-intelligence/index.ts](supabase/functions/recompute-lead-intelligence/index.ts) (667 lines).

Input: `{ lead_id }`.

Pulls in parallel: recent `lead_timeline_items` (30), `conversation_analysis`
across the lead's contacts, `call_analyses` (5 latest, status=completed),
`meeting_summaries`, `lead_context_items` (with HIGH_PRIORITY for
`category in ('caution','relationship_history')`), the `leads` row, and
`deal_memory.handled_objections`.

Writes to `lead_intelligence` (upsert on `lead_id`):

- `summary_text` — 2–3 sentence deal summary (Gemini Flash Lite).
- `recommended_next_step` + `next_step_reason`.
- `milestones_json: [{description, status, date, evidence_ids, source_types}]`.
- `risks_json: [{issue, level, evidence_ids, source_types}]`.
- `objections_json`, `buying_signals_json` (each with `evidence_ids`).
- `engagement_signals_json` — engagement_score, totals, response_rate_pct,
  channel_activity, sentiment_score, urgency_breakdown.
- `channel_recommendations_json` — vote tally of `recommended_reply_channel`
  across all conversation analyses.
- `evidence_json` — top 100 evidence rows
  `{id: "ev-N", source_type, source_id, snippet, channel, occurred_at}`.
- `deal_factors_json.next_step_evidence_ids`.
- `source_counts_json`, `model_used`, `last_computed_at`.

Also mirrors `next_step`, `next_step_reason`, `milestones_json`, `risks_json`,
`last_ai_run_at` back onto `leads` for backward compatibility.

Consumers:
- [src/components/leads/UnifiedIntelligenceCard.tsx](src/components/leads/UnifiedIntelligenceCard.tsx) — reads via `getLeadIntelligence()`.
- [src/components/leads/PendingLeadsTab.tsx](src/components/leads/PendingLeadsTab.tsx) — triggers recompute on accept.
- [src/lib/supabaseQueries.ts:2003–2018](src/lib/supabaseQueries.ts:2003) — `triggerIntelligenceRecompute(leadId)`.

Trigger cadence: on-demand only (no cron). If a queue UI wants fresh
intelligence per lead, it has to invoke this explicitly.

## A7. What `promote-winning-interactions` outputs

File: [supabase/functions/promote-winning-interactions/index.ts](supabase/functions/promote-winning-interactions/index.ts) (150 lines).

Trigger: `cron-dispatcher` only (scheduled, every 6h per CLAUDE.md). Requires
`requireScheduledCaller` auth.

Input: none (scans for unpromoted rows).

Process: fetch ≤20 `winning_interactions` where `promoted_to_kb=false`,
summarize via Gemini Flash Lite into a reusable messaging pattern
(≤200 words), insert into `kb_chunks` with `content_type='messaging'`,
`source='winning_interaction'`, `priority=5`, then mark the source row as
promoted.

Output: HTTP `{ ok, promoted, total, errors? }` and side-effect inserts into
`kb_chunks`.

Consumers of the promoted chunks:
- [supabase/functions/ai_task/index.ts](supabase/functions/ai_task/index.ts):896, 1615
  — KB search includes `content_type='messaging'` for prompt grounding.
- Not directly surfaced in any UI (KB management pages list `kb_chunks` but
  there is no "winning patterns" view).

Producers of `winning_interactions`: `_shared/winningInteractions.ts`
`captureWinningInteraction()`, called from gmail-sync and outlook-sync after
detecting a meeting confirmation, positive reply, etc.

**This is not a per-lead action source** — it is a workspace-level learning
loop. It does not produce queue items.

---

# PART B — UI

## B1. Dashboard ([src/pages/Dashboard.tsx](src/pages/Dashboard.tsx))

Top-level: [Dashboard.tsx:48–279](src/pages/Dashboard.tsx:48).

Data: [getDashboardMetrics()](src/lib/dashboardMetricsService.ts:294) fetches
up to 1000 leads via `supabase.from("leads").select(DASHBOARD_LEAD_COLUMNS)`,
sorted `last_activity_at DESC`. No pagination. All filtering and revenue-state
classification happens client-side via
[dashboardUtils.ts:classifyRevenueState()](src/lib/dashboardUtils.ts:195).

Layout (post-filter):

| Slot | Component | File | Data source |
|---|---|---|---|
| Tab bar | `CommandStrip` | [CommandStrip.tsx](src/components/dashboard/CommandStrip.tsx) | `revenueStateCounts` from metrics |
| Left column | `PriorityActions` (3–5 rows) | [PriorityActions.tsx](src/components/dashboard/PriorityActions.tsx) | filtered `EnrichedLead[]` |
| Right column | `TopMovers` | [TopMovers.tsx](src/components/dashboard/TopMovers.tsx) | filtered `EnrichedLead[]`, derives mover signals from `last_inbound_at`, meeting events |
| Header strip | `AIInsightPanel` | [AIInsightPanel.tsx](src/components/dashboard/AIInsightPanel.tsx) | single computed text signal |
| Main grid | `LeadCard[]` (queue view) or `LeadTable` (table view) | [LeadCard.tsx](src/components/leads/LeadCard.tsx), [LeadTable.tsx](src/components/dashboard/LeadTable.tsx) | filtered leads |

Sort for queue: [Dashboard.tsx:36–46](src/pages/Dashboard.tsx:36) — `needs_action` first, then `last_activity_at DESC`, slice(0, 15).

State cache: [dashboardStateCache.ts](src/lib/dashboardStateCache.ts) persists revenueStateFilter, viewMode, tabFilters, scroll position across navigation.

### `PriorityActions` deep dive — closest existing thing to a queue

[PriorityActions.tsx:44–335](src/components/dashboard/PriorityActions.tsx:44):

- Filters parent's leads to `revenueState === "action_required"` (line 74).
- Sorts by `URGENCY_PRIORITY` map (lines 28–35): `reply_now` (1) >
  `generate_post_meeting_recap` (2) > `send_proposal` (3) > …
- Limit: 5 on the action_required tab, 3 elsewhere.
- Per row: name, company, stage, `next_action_label`, draft-pregeneration
  status icon (via `useBackgroundDraftQueue`), action button (routes through
  `actionRouter.ts`), snooze dropdown (1/3/7d) and permanent dismiss.

Mutations: `dismissLeadAction(leadId, snoozeDays)`,
`setLeadPermanentDismiss(leadId, true)` ([supabaseQueries.ts](src/lib/supabaseQueries.ts)).

### Dead-looking dashboard components

These files exist but are not imported by any page:

| File | Status |
|---|---|
| [src/components/dashboard/ActionRequiredPanel.tsx](src/components/dashboard/ActionRequiredPanel.tsx) | not imported anywhere |
| [src/components/dashboard/AIActivityFeed.tsx](src/components/dashboard/AIActivityFeed.tsx) | not imported anywhere |
| [src/components/dashboard/AIRecommendation.tsx](src/components/dashboard/AIRecommendation.tsx) | not imported anywhere (`getAIRecommendation` helper still lives in `dashboardUtils.ts:501`) |
| [src/components/dashboard/SummaryCards.tsx](src/components/dashboard/SummaryCards.tsx) | only a `FilterType` import is re-used by `IntelligenceCards` |
| [src/components/dashboard/IntelligenceCards.tsx](src/components/dashboard/IntelligenceCards.tsx) | not imported anywhere |
| [src/components/dashboard/DealFlowBar.tsx](src/components/dashboard/DealFlowBar.tsx) | not imported anywhere |
| [src/components/dashboard/FilterBar.tsx](src/components/dashboard/FilterBar.tsx) | not imported anywhere |
| [src/components/dashboard/StageFilterBar.tsx](src/components/dashboard/StageFilterBar.tsx) | not imported anywhere |

`CommandStrip` superseded `FilterBar`/`StageFilterBar`/`SummaryCards`. Verified
via `Grep "from ['\"].*<name>['\"]" src` — zero call-sites.

## B2. Lead surfaces

### Lead list — [src/pages/Leads.tsx](src/pages/Leads.tsx)

- Data: [getLeadsList()](src/lib/supabaseQueries.ts:98) → 200 rows from
  `leads`, sorted `last_activity_at DESC`, RLS-filtered to owner.
- Tabs: All Leads vs Pending Candidates.
- Search: client-side ILIKE on name/company/email (≥2 chars).
- Renders `LeadCard` in list context (larger format).

### Pending candidates — [PendingLeadsTab.tsx](src/components/leads/PendingLeadsTab.tsx)

Reads `lead_candidates` (per PROGRESS.md, table created by PR #3/4 of the
Lead Candidates pipeline). Per-row: `contact_email`, `ai_score` (color-coded
70/40), `ai_reason`, `subject_snippet`, `body_snippet`, accept/reject/snooze
controls. Sorted by `ai_score DESC`. Workspace-scoped.

This is a separate queue from the action queue — it's about whether to
*create* a lead, not what to do with one.

### Lead detail — [src/pages/LeadDetail.tsx](src/pages/LeadDetail.tsx)

Data: [getLeadDetail(leadId)](src/lib/supabaseQueries.ts:145).

Layout: 2/3 left (tabs) + 1/3 right (sidebar).

Tabs:
- **Timeline** → [TimelineTab.tsx](src/components/lead/TimelineTab.tsx) (see below).
- **Drafts** → [DraftsTab.tsx](src/components/lead/DraftsTab.tsx).
- **Meetings** → [MeetingsTab.tsx](src/components/lead/MeetingsTab.tsx).
- **Upload** → [UploadTab.tsx](src/components/lead/UploadTab.tsx).
- **Deep Analysis** → [RecommendationsTab.tsx](src/components/lead/RecommendationsTab.tsx).

Above the tabs: [UnifiedIntelligenceCard](src/components/leads/UnifiedIntelligenceCard.tsx)
in compact mode (top 3 per category from `lead_intelligence`).

Sidebar:
- [LeadDetailHeader.tsx](src/components/lead/LeadDetailHeader.tsx) — name, company, stage, motion, automation label (derived from `motion`, `stage`, `eligible_at`, `needs_action`, `last_inbound_at`, `has_future_meeting`, `nurture_status`, `nurture_mode`), `calculateClosingPower()`.
- [LeadOverviewPanel.tsx](src/components/lead/LeadOverviewPanel.tsx) — last meeting (via `getLeadMeetingPacks`), milestones, risks, buying signals (regex on milestone descriptions), automation/nurture preview cards.
- [LeadContextPanel.tsx (lead/)](src/components/lead/LeadContextPanel.tsx) — CRUD on `lead_context_items` grouped by category.
- [StakeholdersPartnersPanel.tsx](src/components/lead/StakeholdersPartnersPanel.tsx) — group members + partner contacts.

### `TimelineTab` — [TimelineTab.tsx](src/components/lead/TimelineTab.tsx)

Pulls `lead_timeline_items` via `getLeadTimeline()`. Sorted `occurred_at DESC`.
Hides rows where `status_json.hidden=true` unless toggled.

Notable reply-worthiness logic ([TimelineTab.tsx:98–142](src/components/lead/TimelineTab.tsx:98)):

- "Reply"/"Follow-up" buttons surface only for inbound rows.
- Filters out bounce / `no-reply` senders.
- Picks the most recent unreplied inbound per `(sender, thread-key)`.
- Respects per-row `timeline_followup_state` (snooze/dismiss; client-side
  state stored on the timeline row).
- Skips if subject or metadata indicates OOO.

This is **the only place in the UI that already does per-row "is this worth
replying to" gating**. It re-runs the gating on the client every render — it
is not driven by a stored intent column.

If the user is viewing a lead inside a `lead_groups` group, the tab unions
timeline items across all members via `getGroupTimelineItems(groupId)`.

### `UnifiedIntelligenceCard` — [UnifiedIntelligenceCard.tsx](src/components/leads/UnifiedIntelligenceCard.tsx)

Reads `lead_intelligence` via `getLeadIntelligence()`, falls back to
`lead.milestones_json` / `lead.risks_json`. Compact mode (lead detail) shows
top 3 per category; full mode shows top 10. Sections: Milestones, Risks,
Objections, Buying Signals, Lead Signals (enrichment).

## B3. Inbox surfaces — [src/pages/Inbox.tsx](src/pages/Inbox.tsx) → [InboxView.tsx](src/components/inbox/InboxView.tsx)

3-pane layout:

| Pane | Component | Data source |
|---|---|---|
| Left | [ConversationList.tsx](src/components/inbox/ConversationList.tsx) | [fetchConversations(filters)](src/lib/inboxQueries.ts:81) — groups leads by latest `lead_timeline_items` (≤1000) |
| Middle | [ConversationThread.tsx](src/components/inbox/ConversationThread.tsx) | `fetchDecryptedMessages(leadId)` + `fetchContactAnalysis(leadId)` |
| Right (tabbed) | "Next" → reply suggestions, "Insights" → [IntelligencePanel.tsx](src/components/inbox/IntelligencePanel.tsx) + [UnifiedInsightsPanel.tsx](src/components/inbox/UnifiedInsightsPanel.tsx), "Lead" → [LeadContextPanel.tsx (inbox/)](src/components/inbox/LeadContextPanel.tsx) | `fetchLeadSnapshot`, `getLeadIntelligence`, `fetchAllContactAnalysis` |

Filter bar:

- Search (300 ms debounce, ILIKE on name/company/email ≥2 chars).
- Tabs: Active / New / Archived (drives `stage`/`status` filter).
- Quick chips: `needs_action`, `new_inbound`, `overdue`.
- Channel filter dropdown (email/SMS/WhatsApp/voice).
- Sort: Most Recent / Most Urgent / Oldest First / New Inbound.

State persisted in [inboxStateCache.ts](src/lib/inboxStateCache.ts).

`IntelligencePanel` surfaces AI-derived fields from `conversation_analysis`:
`summary_short`, `summary_text`, `sentiment`, `urgency`, `topics`,
`extracted_features.objections`, `extracted_features.buying_signals`,
`extracted_features.ghosting_risk`, `extracted_features.deal_stage`,
`extracted_features.reply_suggestions`.

## B4. Duplicated and parallel UI paths

| What | Where | Notes |
|---|---|---|
| Two `LeadContextPanel.tsx` files | [src/components/lead/LeadContextPanel.tsx](src/components/lead/LeadContextPanel.tsx), [src/components/inbox/LeadContextPanel.tsx](src/components/inbox/LeadContextPanel.tsx) | Different data sources (CRUD on `lead_context_items` vs. read-only lead snapshot); not a bug, but easy to confuse |
| Email send paths | [src/components/inbox/ReplyComposer.tsx](src/components/inbox/ReplyComposer.tsx), [src/lib/mailProviders/GmailProvider.ts](src/lib/mailProviders/GmailProvider.ts), [src/hooks/useMailSync.ts](src/hooks/useMailSync.ts) | Already flagged in CLAUDE.md "Open hazards" |
| Lead scoring | [src/lib/closingPowerUtils.ts](src/lib/closingPowerUtils.ts) (client) vs [supabase/functions/recompute-lead-intelligence/index.ts](supabase/functions/recompute-lead-intelligence/index.ts) (server) | Flagged in CLAUDE.md; no sync |
| `interactions` vs `lead_timeline_items` | Many dual-read sites in [src/lib/leadActivity.ts](src/lib/leadActivity.ts), [src/lib/supabaseQueries.ts](src/lib/supabaseQueries.ts) | Mid-migration, flagged in CLAUDE.md |
| Two intelligence stores | `lead_intelligence` (canonical) vs mirror fields on `leads` (`next_step`, `next_step_reason`, `milestones_json`, `risks_json`) | Written together by `recompute-lead-intelligence:648–654` |
| `automation_log` vs `automation_logs` | Different schemas, both active | Flagged in CLAUDE.md |
| `match_knowledge_chunks_v2` vs v1/unnumbered | v2 canonical, others deprecated | Flagged in CLAUDE.md |

---

# Reuse vs. Build

## Reuse — already in the codebase

| Capability | Source | Why it's reusable |
|---|---|---|
| Canonical comms event store | `lead_timeline_items` schema | Channel/direction/event_type/source already classified; dedupe is solid |
| Per-lead stored "needs reply" verdict | `leads.needs_action`, `next_action_key`, `next_action_label`, `eligible_at`, `action_reason_code` | Computed by a single function with documented thresholds; updates on every sync |
| Snooze + permanent-dismiss machinery | `leads.action_dismissed_at`, `leads.action_permanently_dismissed`, [dismissLeadAction()](src/lib/supabaseQueries.ts), [setLeadPermanentDismiss()](src/lib/supabaseQueries.ts) | Already wired with auto-clear on fresh inbound |
| Action urgency ordering | `URGENCY_PRIORITY` map in [PriorityActions.tsx:28–35](src/components/dashboard/PriorityActions.tsx:28) | Captures product opinion of "what to handle first" |
| Compact action-row UI | [PriorityActions.tsx](src/components/dashboard/PriorityActions.tsx) (row component, status icons, draft pre-gen hook, snooze dropdown) | Drop-in row for a larger queue page |
| Action routing | [src/lib/actionRouter.ts](src/lib/actionRouter.ts) | Maps `next_action_key` → UI handler |
| Per-row reply-worthiness gating | [TimelineTab.tsx:98–142](src/components/lead/TimelineTab.tsx:98) | Filters bounces, no-reply senders, OOO, snoozed rows — port the predicate to the queue |
| Inbound classification | `ai_task` `intent_router` task (book_meeting/pricing/security/legal/partnership/support/not_sure + urgency + reply_worthy) | Already prompted and tested; just needs a scheduled caller |
| Per-row hide/snooze on timeline | `lead_timeline_items.status_json.hidden`, `followup_snoozed_until`, `followup_dismissed_at` | Existing schema for "don't show this email again" |
| OOO/bounce/meeting/unsubscribe/defer detection | `_shared/oooDetection.ts`, `_shared/meetingConfirmation.ts`, `_shared/unsubscribeDetection.ts`, inline gmail/outlook sync rules | Can be ported to a queue-side filter; already produces a `system_note` row |
| Lead-level intelligence aggregation | `lead_intelligence` (milestones/risks/objections/buying_signals/engagement_signals_json/channel_recommendations_json/evidence_json) | Single canonical row per lead, on-demand refresh |
| Inbox filter UX patterns | [InboxView.tsx](src/components/inbox/InboxView.tsx) (search + tabs + quick chips + channel filter + sort + persisted state cache) | Direct model for the queue's filter bar |
| Lead snapshot pull for queue rows | [fetchLeadSnapshot()](src/lib/inboxQueries.ts) | Light per-row hydration without re-fetching the whole lead |
| Background draft pre-generation | [useBackgroundDraftQueue](src/hooks/useBackgroundDraftQueue.ts) used by PriorityActions | Already drafts a reply before the rep clicks |
| State cache helpers | [dashboardStateCache.ts](src/lib/dashboardStateCache.ts), [inboxStateCache.ts](src/lib/inboxStateCache.ts) | Pattern for persisting filter/sort across navigation |

## Build — genuinely missing

| Gap | Why we need it | Notes |
|---|---|---|
| **A `timeline_item.intent` / `category` column** (or a joined `timeline_item_classifications` table) | The single biggest blocker. Today, nothing on a timeline row tells you whether it's a calendar accept, Zoom recap, OOO, bounce, or a real human reply. The detectors run during sync but only mutate `leads.*` and emit a separate `system_note` row | Schema add + backfill from existing detectors; the detection functions already exist, they just need to write back to the row |
| **Automatic `intent_router` invocation on inbound** | `ai_task` can classify but nothing calls it on each inbound. The dashboard cannot say "this inbound is a pricing question, this one is a calendar accept" without it | Either inline in gmail-sync/outlook-sync after `createCanonicalInteraction()`, or a separate `classify-inbound` cron over rows where intent is null |
| **A first-class `action_items` table** (or materialized view) | All "needs reply" decisions live on `leads.next_action_*`. There is only one open action per lead. If we want a richer queue with per-thread / per-stakeholder items, multi-step tasks, manual TODOs from a rep, etc., we need a real table | Could be virtual at first (a SQL view over leads + timeline) before going table-backed |
| **Cron-driven `recompute-lead-intelligence`** | It only runs on-demand. A queue that ranks by risk/buying-signal/objection needs intelligence to be fresh | Add to `cron-dispatcher` ALLOWED_TARGETS and create a cron job |
| **Dedicated "Action Queue" page/route** | `PriorityActions` shows 3–5 rows on the dashboard. There is no `/app/queue` (or similar) with pagination, full filtering and bulk actions | Reuse `PriorityActions` row component; reuse Inbox filter-bar patterns |
| **Bulk actions on actions** | Snooze + dismiss exist per-row only. No "snooze all OOO-blocked leads", "dismiss all calendar-accept replies", etc. | Once intent column exists, bulk by intent becomes trivial |
| **Cleanup of dead dashboard UI** | `ActionRequiredPanel`, `AIActivityFeed`, `AIRecommendation`, `SummaryCards`, `IntelligenceCards`, `DealFlowBar`, `FilterBar`, `StageFilterBar` are all orphaned and confusing | Pure delete; no logic to preserve |
| **Stale-action invalidation when the rep replies via a non-tracked path** | `needs_action` only clears when the next sync sees an outbound. Reps who reply outside Gmail/Outlook (e.g. dictated to assistant, WhatsApp from phone) leave the queue showing stale "Reply now" rows | Either lean on existing send paths or add a "I've handled this" manual clear |
| **Real ICS / `text/calendar` parsing on inbound mail** | calendar-sync only pulls from the Calendar API; if a sender emails an `.ics` attachment from an unconnected calendar provider, we never see it as a meeting event | Out of scope for V1 if `meetingConfirmation` heuristics suffice |
| **One source of truth for closing power / lead scoring** | Client-side `closingPowerUtils.ts` and server-side `recompute-lead-intelligence` compute overlapping scores with no sync (CLAUDE.md open hazard) | Pick server canonical; remove client computation |

## Minimum V1 queue, in terms of the above

If we wanted to ship a clean action queue with smallest possible build:

1. Add `intent` column to `lead_timeline_items` (text, nullable, indexed on `(lead_id, intent)`).
2. Backfill from current detectors (OOO/bounce/meeting/Zoom recap/unsubscribe) — write the verdict to the row that triggered them, not just to `system_note`.
3. Trigger `ai_task.intent_router` from gmail-sync/outlook-sync for inbounds that pass the bot filters; persist the result to `intent` and `status_json.ai_reply_worthy`.
4. Build `/app/queue` as a paginated list of leads where `needs_action=true` AND `action_dismissed_at IS NULL` AND `action_permanently_dismissed=false`, ordered by `URGENCY_PRIORITY[next_action_key]` then `last_inbound_at DESC`. Reuse `PriorityActions`'s row component and the Inbox filter-bar pattern. Hide rows whose latest inbound has `intent IN ('calendar_accept', 'ooo_reply', 'bounce', 'zoom_recap')`.
5. Delete the dead dashboard components.

Everything else listed under **Build** is incremental on top of that.
