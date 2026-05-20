# EDGE_CASES.md — Action-queue plan, edge-case verification

Date: 2026-05-20. Read-only audit; no code changed.
Companion to [AUDIT.md](AUDIT.md). All file:line citations are against
the current worktree.

---

## 1. Detector disagreement (OOO ∧ Meeting confirmation)

**A. Verified real risk — partial.** Precedence IS defined (OOO short-circuits
meeting). But neither precedence nor body-aware override exists for
"meeting accept + substantive question" (see #4).

**B. Where the logic lives:**

- Both detectors are called sequentially per inbound message inside the
  per-message try block in [supabase/functions/gmail-sync/index.ts:422–499](supabase/functions/gmail-sync/index.ts) and
  [supabase/functions/outlook-sync/index.ts:308–381](supabase/functions/outlook-sync/index.ts).
- Order in gmail-sync:
  1. Bounce check ([gmail-sync/index.ts:387–420](supabase/functions/gmail-sync/index.ts:387)) — sets `unsubscribed=true` but **does not `continue`**.
  2. OOO check ([gmail-sync/index.ts:422–443](supabase/functions/gmail-sync/index.ts:422)) — `applyOOOPause()` writes its own `system_note` and on success runs `continue;` ([line 441](supabase/functions/gmail-sync/index.ts:441)) which **skips meeting + unsubscribe + the canonical interaction insert** for this message.
  3. Defer check ([gmail-sync/index.ts:445–456](supabase/functions/gmail-sync/index.ts:445)) — does NOT `continue`.
  4. Meeting confirmation ([gmail-sync/index.ts:458–499](supabase/functions/gmail-sync/index.ts:458)) — direct DB `update({ has_future_meeting: true, needs_action: false })`. Does NOT `continue`.
  5. Unsubscribe ([gmail-sync/index.ts:501–531](supabase/functions/gmail-sync/index.ts:501)).
  6. `createCanonicalInteraction(...)` ([line 533](supabase/functions/gmail-sync/index.ts:533)).
- outlook-sync mirrors this order exactly: bounce, OOO+continue, defer, meeting (no continue), unsubscribe, canonical insert.

**Precedence behaviour today:**

- OOO wins outright. If a reply matches OOO it never reaches meeting/defer/unsubscribe checks for that message (skipped by `continue`). The OOO `system_note` is the only one written for this email.
- If OOO does NOT match but meeting confirmation does, BOTH `applyDeferPause()` (if defer matches) and the meeting handler can each write their own `system_note`. They don't overwrite each other — each `createCanonicalInteraction` call uses a content-fingerprint dedupe_key, so a defer note and a meeting note coexist as separate system_note rows on the timeline.
- The `leads.*` flags are last-write-wins within the message handler — meeting confirmation writes `needs_action=false` directly, then the canonical email insert runs, then the per-lead `deriveAction()` at [gmail-sync/index.ts:640–668](supabase/functions/gmail-sync/index.ts:640) can flip `needs_action` back to true (see #4).

**There is also a stale-variable bug worth flagging:** `hasFutureMeeting` is
read once at [gmail-sync/index.ts:224](supabase/functions/gmail-sync/index.ts:224)
and [outlook-sync/index.ts:155](supabase/functions/outlook-sync/index.ts:155),
**before the message loop**. If a meeting confirmation in this batch sets
`has_future_meeting=true`, the local variable stays `false` and the
end-of-sync `deriveAction()` is called with the stale value — so the
`pause_when_meeting_scheduled` guard at
[_shared/syncEngine.ts:368](supabase/functions/_shared/syncEngine.ts:368)
does not trigger this run. It will only kick in on the next sync after the
DB value has settled.

**C. Smallest fix:**

- **Phase 1:** No new code — just document precedence (OOO > all). Already correct.
- **Phase 2:** Re-read `has_future_meeting` (or refresh the local variable) right before the end-of-sync `deriveAction()` call in both gmail-sync and outlook-sync. Two-line fix.
- **Phase 3 / when we add intent column:** All five detectors write their verdict to the new `lead_timeline_items.intent` column on the row they triggered on, in addition to the existing side effects. That gives one row, one classification, removes the stale-variable race entirely.

---

## 2. AI call failure during sync

**A. Verified real risk if naively inlined — bounded.** The existing
ai_task callers from sync paths run **post-send, inside a non-blocking
background block**, never inline before a DB write. If we inline
`intent_router` in the per-message loop without care, an AI 5xx/timeout
will leak into the per-message catch and land in the `errors[]` array but
will **not** abort the rest of the batch.

**B. Where the logic lives:**

- Per-message catch in gmail-sync at [gmail-sync/index.ts:559–561](supabase/functions/gmail-sync/index.ts:559) and outlook-sync at [outlook-sync/index.ts:433–435](supabase/functions/outlook-sync/index.ts:433). Any thrown error from a message becomes an `errors.push(...)` entry; the loop continues with `synced` already incremented if the canonical insert succeeded.
- Existing ai_task callers from sync-adjacent code:
  - [gmail-send/index.ts:386–457](supabase/functions/gmail-send/index.ts:386) — call sits inside a `backgroundTasks` arrow at [line 320](supabase/functions/gmail-send/index.ts:320) and a `try`/`catch` at [line 388](supabase/functions/gmail-send/index.ts:388). Failure is logged, never thrown.
  - [outlook-send/index.ts:548–567](supabase/functions/outlook-send/index.ts:548) — same pattern, inside a try.
  - [sms-send/index.ts:255](supabase/functions/sms-send/index.ts:255) — same.
  - [meeting-transcript-analyze/index.ts:190–220](supabase/functions/meeting-transcript-analyze/index.ts:190) — invokes `ai_task` and DOES bail with `jsonResponse(502)` on non-200. But this is a single-job edge function, not a per-message loop.
  - [automation-executor/index.ts:917–918](supabase/functions/automation-executor/index.ts:917) — per-lead AI call inside the executor loop; failures don't abort the executor.

**C. Smallest fix:**

- **Phase 1 / decision point:** If we inline classification in sync, wrap it in a per-message `try`/`catch` that:
  - never throws,
  - sets `intent` to `null` on failure,
  - increments a `classification_failed` counter logged once at end of batch.
- **Phase 2 (recommended):** Don't inline at all. Add a separate scheduled `classify-inbound` job (similar to `score-lead-candidate` per PROGRESS.md line 17) that picks up `lead_timeline_items WHERE intent IS NULL AND event_type='email_inbound'` in batches. Decouples AI cost/latency from the human-visible sync path entirely.
- This belongs in **Phase 2** of the queue rollout — Phase 1 can ship with NULL intent + heuristic-only filtering (matching today's behaviour).

---

## 3. Mark-as-handled vs fresh-inbound race

**A. Verified no risk** — the existing machinery handles this correctly.

**B. Where the logic lives:**

- The clear path is in [_shared/syncEngine.ts:586–600 + 673–678](supabase/functions/_shared/syncEngine.ts:586):

```ts
// 586–591
const dismissedAt = actionDismissedAt ? new Date(actionDismissedAt).getTime() : 0;
const lastInteractionTime = Math.max(
  metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0,
  metrics.last_inbound_at ? new Date(metrics.last_inbound_at).getTime() : 0,
);

// 596–600
if (dismissedAt > 0 && dismissedAt > lastInteractionTime) {
  finalAction = { needs_action: false, ... };
} else if (dismissedAt > 0 && lastInteractionTime > dismissedAt) {
  shouldClearDismissal = true;
}

// 673–678
if (shouldClearDismissal) {
  leadUpdate.action_dismissed_at = null;
  // PR 2.4 — also re-arms a permanently-dismissed lead.
  (leadUpdate as Record<string, unknown>).action_permanently_dismissed = false;
}
```

- Both `action_dismissed_at` AND `action_permanently_dismissed` clear together on a fresh inbound — this is intentional (PR 2.4 comment in code).
- A new "manual handled" path that sets `action_dismissed_at = now()` would behave correctly: a subsequent inbound (any direction past `dismissedAt`) flips `shouldClearDismissal=true` and `deriveAction()` re-evaluates to `reply_now`.

**C. Smallest fix:** None required.

**Caveat worth noting (informational, not a blocker):** the clear is driven
by `last_outbound_at` OR `last_inbound_at` being newer than the dismiss
timestamp. If a rep marks-as-handled, then sends an outbound (which updates
`last_outbound_at`), the snooze auto-clears — i.e. *the rep's own send*
counts as activity that re-arms the action. That is probably what we want
(they're now waiting for a reply again) but worth confirming in product
design before launch. **KNOWN_ISSUES.md** material if anything.

---

## 4. Calendar accept with substantive reply

**A. Verified real risk.** `detectMeetingConfirmation()` short-circuits on
subject match and never inspects body content for embedded questions.

**B. Where the logic lives:**

- [_shared/meetingConfirmation.ts:44–72](supabase/functions/_shared/meetingConfirmation.ts:44):
  ```ts
  // 1. Calendar acceptance subjects (strongest signal)
  for (const pattern of CALENDAR_SUBJECT_PATTERNS) {
    if (pattern.test(subject)) {
      return { isConfirmed: true, confidence: "subject", matchedText: subject.slice(0, 80) };
    }
  }
  // 2. Body patterns (secondary signal)
  for (const pattern of MEETING_BODY_PATTERNS) {
    ...
  }
  ```
  `CALENDAR_SUBJECT_PATTERNS` ([meetingConfirmation.ts:24–31](supabase/functions/_shared/meetingConfirmation.ts:24)) are `^Accepted:`, `^Tentatively Accepted:`, `^Invitation:` — pure prefix anchors on subject. No body length or question-mark check.
- When the detector returns `isConfirmed: true`, [gmail-sync/index.ts:463–466](supabase/functions/gmail-sync/index.ts:463) writes `has_future_meeting=true, needs_action=false`.

**What actually surfaces in the queue:**

The reply "Accepted: Demo Thursday — by the way, can you send pricing?" hits
two competing paths in the same sync run:

1. **In-loop:** meeting detector trips → `needs_action=false`, `has_future_meeting=true`, system_note "📅 Meeting confirmed". Canonical email still inserted.
2. **End-of-loop:** `deriveAction()` runs with **stale** `hasFutureMeeting=false` (see #1 caveat), so the REPLY PENDING branch at [_shared/syncEngine.ts:394–407](supabase/functions/_shared/syncEngine.ts:394) wins and writes `needs_action=true, next_action_key="reply_now"`.

Net: on the sync run that catches this email, `needs_action=true` (good for
the queue). But on the NEXT sync (no new mail), `hasFutureMeeting` reads
fresh as `true`, `pause_when_meeting_scheduled` ([syncEngine.ts:368](supabase/functions/_shared/syncEngine.ts:368)) fires, and `needs_action` flips back to `false`. The pricing question silently disappears from the queue between syncs.

**C. Smallest fix:**

- **Phase 2:** In `detectMeetingConfirmation()`, when `confidence === "subject"`, also scan the body for question marks or "?" + (`pricing` | `price` | `cost` | `quote` | `proposal` | `contract` | `timeline` | `when` | `how`) and return a softer `isConfirmed: false, hasSubstantiveQuestion: true` so the meeting handler does NOT set `needs_action=false`. Body-aware override.
- **Phase 1 workaround:** Fix the stale `hasFutureMeeting` variable (#1 Phase 2 fix) so behavior is at least *consistently* "meeting suppresses reply prompt". Then it's an obvious product gap rather than a flicker.
- **Phase 3 / when intent column exists:** classify the row as `meeting_accept + has_question` and let the queue surface it with a "calendar accept + question" tag.

---

## 5. Same email on multiple leads

**A. Verified real risk — design intent, not a bug. Burns AI tokens twice
if Phase 1 backfill iterates per row.**

**B. Where the logic lives:**

- `gmail-sync` takes a single `leadId` per call ([gmail-sync/index.ts:187](supabase/functions/gmail-sync/index.ts:187): `const { leadId, leadEmail, maxResults = 20 } = await req.json();`). It does NOT loop over leads — only over messages within that one lead's Gmail search results.
- `gmail-bulk-sync` DOES loop over leads ([gmail-bulk-sync/index.ts:958](supabase/functions/gmail-bulk-sync/index.ts:958): `for (const lead of leadsData)`) and runs the same per-message detection per lead.
- Upsert key is `(lead_id, dedupe_key)` ([migrations/20260324154224_…sql:40](supabase/migrations/20260324154224_5c08870b-2f6c-49b1-8d26-ed8ff3e614f7.sql:40)):
  ```sql
  CONSTRAINT uq_lead_timeline_dedupe UNIQUE (lead_id, dedupe_key)
  ```
  The dedupe key is `gmail:<message_id>` ([gmail-sync/index.ts:550](supabase/functions/gmail-sync/index.ts:550)). So a Gmail message that's relevant to two leads owned by two reps produces **two timeline rows with the same `dedupe_key` but different `lead_id`** — which the constraint permits. Confirmed in CC scenario.

**Backfill burn risk:** if a Phase 1 backfill processes rows one at a time
(`UPDATE lead_timeline_items SET intent=... WHERE id=$1`), the same Gmail
content body will be re-classified for each lead it's been projected to.
For a workspace with N reps and a shared customer thread, that's an Nx
multiplier on Gemini tokens.

**C. Smallest fix:**

- **Phase 1 backfill:** classify per unique `(channel, source_table, source_id)` (effectively per Gmail message_id) into an in-memory or temp-table cache, then write the same verdict to all rows that share it. A `(channel, dedupe_key) → intent` map.
- **Phase 1 live classification:** classify per message, then write to all timeline rows where `dedupe_key = $X` (i.e. `UPDATE … WHERE dedupe_key = $X` instead of `WHERE id = $X`). Same idea.
- **Doesn't change schema.** Belongs in Phase 1.

---

## 6. SaaS-tool auto-replies (Salesforce, Zendesk, etc.)

**A. Probably caught by header detection. Real but bounded risk.**

**B. Where the logic lives:**

- [_shared/oooDetection.ts:23–29](supabase/functions/_shared/oooDetection.ts:23) — `OOO_HEADER_INDICATORS` matches:
  - `Auto-Submitted: auto-replied|auto-generated` ← Salesforce notifications typically set `Auto-Submitted: auto-generated`.
  - `X-Auto-Response-Suppress: <any>` ← Zendesk and friends often set this.
  - `Precedence: auto-reply|junk|bulk` ← bulk notifications.
- A matched SaaS notification triggers `applyOOOPause()` ([_shared/oooPauseActions.ts:37–77](supabase/functions/_shared/oooPauseActions.ts:37)), which falls back to `getOOOEligibleAt(null)` → "now + 7 days" when no return date can be parsed ([oooDetection.ts:185–193](supabase/functions/_shared/oooDetection.ts:185)).

Additional mitigation already in place: `gmail-sync` queries Gmail for the
*lead's* email address, so SaaS notifications from `notifications@salesforce.com`
would only surface if the rep was CC'd on a lead-addressed thread — uncommon.

**C. Smallest fix:**

- **KNOWN_ISSUES.md** — note that SaaS notifications mistakenly looking like
  OOO will pause the lead for 7 days. Low frequency. Document the
  mitigation: rep removes via the snooze undo or sends an outbound (clears
  the pause via the standard sync path).
- **Optional Phase 3:** add `from:` allowlist exception (skip OOO detection if `from_email` matches `mailer-daemon|postmaster|noreply|no-reply` since those are handled by bounce detection, and skip OOO if subject is clearly a SaaS notification — heuristic only).

---

## 7. Silent send failures (gmail-send / outlook-send)

**A. Verified low risk in gmail-send; small remaining risk in outlook-send.**

**B. Where the logic lives:**

- **gmail-send** ([gmail-send/index.ts:300–342](supabase/functions/gmail-send/index.ts:300)):
  - Path branches on `sendResponse.ok` at [line 300](supabase/functions/gmail-send/index.ts:300). If not OK, returns an error JSON to the client and never enters the post-send pipeline.
  - The Gmail API only returns `sendData.id` on a successful queue-for-send, which is what gets written as `gmail_message_id` ([line 338](supabase/functions/gmail-send/index.ts:338)).
  - `deriveAction()` is not called here at all — gmail-send just writes the row and updates a few lead fields. The sync engine re-evaluates on the next inbound or scheduled tick.
- **outlook-send** ([outlook-send/index.ts:450–528](supabase/functions/outlook-send/index.ts:450)):
  - Uses a `lookupSentMessageId()` fallback ([line 454](supabase/functions/outlook-send/index.ts:454)) to re-fetch the message from Sent Items after Graph's send response.
  - If the lookup fails (Graph returns 200 but the message never lands in Sent Items, or the fetch errors), `providerMessageId` stays `null` ([line 451–474](supabase/functions/outlook-send/index.ts:451)). The interaction row is **still written** at [line 480](supabase/functions/outlook-send/index.ts:480) with `gmail_message_id: null`. A `logger.warn("mail.outlook.sent_items_capture_missed", ...)` is the only signal.

**C. Smallest fix:**

- **gmail-send:** none needed.
- **outlook-send:** **KNOWN_ISSUES.md** — note that `gmail_message_id IS NULL`
  on an outlook interaction row indicates a Sent Items capture miss; the
  row's existence does not guarantee delivery. This is a pre-existing
  weakness, orthogonal to the action queue. Action queue should treat
  `outlook` outbound rows with `null` provider_message_id as "probably sent"
  and not as a confirmed reply that clears `needs_action`. Today,
  `metrics.last_outbound_at` is updated regardless, so an outlook send
  failure could silently flip a lead out of the action_required state.

---

## 8. Snooze + inbound + classification ordering

**A. Verified no race today.** Adding classification doesn't break the
order if it's wrapped (see #2).

**B. Where the logic lives — current order per message (gmail-sync, outlook-sync similar):**

1. Read `action_dismissed_at` at [gmail-sync/index.ts:225](supabase/functions/gmail-sync/index.ts:225) (before the loop).
2. Per message: bounce, OOO+continue, defer, meeting, unsubscribe checks.
3. `createCanonicalInteraction()` writes both `interactions` and `lead_timeline_items` ([gmail-sync/index.ts:533](supabase/functions/gmail-sync/index.ts:533)).
4. Loop ends. `computeMetricsFromInteractions()` from fresh DB read.
5. `deriveAction()` returns `{needs_action:true, "reply_now"}` if inbound > outbound past threshold.
6. `buildLeadUpdate()` ([_shared/syncEngine.ts:596–600 + 673–678](supabase/functions/_shared/syncEngine.ts:596)):
   - If `lastInteractionTime > dismissedAt` → `shouldClearDismissal=true`.
   - Writes `action_dismissed_at=null`, `action_permanently_dismissed=false`, `needs_action=finalAction.needs_action`.

**Order with Phase 1 classification (inline, recommended placement):**

Per message: detector chain → `createCanonicalInteraction` → **classify
intent and patch `lead_timeline_items.intent`** → next message. Then end-of-loop
deriveAction → buildLeadUpdate → snooze clears. Classification slots in
between the row insert and the per-lead recompute — it does not affect
snooze clearing.

**Order with Phase 2 (out-of-band classifier):** snooze logic unchanged. Classifier writes intent asynchronously; UI filters tolerate `intent IS NULL` (treat as "needs classification").

**C. Smallest fix:** None to the existing flow. Just document the chosen
placement (inline post-insert vs. out-of-band). Phase 1 default: **inline post-insert with non-throwing try/catch**.

---

## 9. "Why is this back?" — surfacing resurfacing

**A. Verified real gap.** No UI today indicates a lead has been
auto-resurfaced after a previous dismiss.

**B. Where the logic lives:**

- [PriorityActions.tsx](src/components/dashboard/PriorityActions.tsx) renders only `lead.name`, stage, `next_action_label || "Action needed"`, pre-gen status icon, action button, snooze/dismiss menu. No "previously dismissed" badge.
- Grep for resurfacing-related strings ("resurfaced", "previously dismissed", "came back", "reactivated") in `src/components` → 0 matches.
- The snooze and permanent-dismiss flags are cleared silently by [_shared/syncEngine.ts:673–678](supabase/functions/_shared/syncEngine.ts:673); no audit-log table records the transition.

**C. Smallest fix:**

- **Phase 2:** add an `action_resurfaced_at` column (or a `lead_action_events` log table) that the syncEngine stamps when it auto-clears `action_dismissed_at` / `action_permanently_dismissed` due to a fresh inbound. The queue UI shows a "↻ Resurfaced 2h ago" pill on those rows.
- **Phase 1 cheat:** infer from `lead.last_inbound_at > lead.action_dismissed_at` (works only while the dismiss timestamp is still present); but syncEngine *clears* the column, so this signal is gone after the next sync. So you really do need an extra column or log to do this right.
- **KNOWN_ISSUES.md** if not scheduled.

---

## 10. CommandStrip count accuracy with intent filtering

**A. Verified real risk if Phase 1 ships before counts get updated.**
Counts are stage/state-based and have no awareness of intent.

**B. Where the logic lives:**

- [CommandStrip.tsx:21–55](src/components/dashboard/CommandStrip.tsx:21) — pure dumb component, just renders `counts[seg.key]`.
- `counts` is `revenueStateCounts` from [src/lib/dashboardMetricsService.ts:294–412](src/lib/dashboardMetricsService.ts:294), computed by tallying `lead.revenueState` from [dashboardUtils.classifyRevenueState()](src/lib/dashboardUtils.ts:195).
- `classifyRevenueState` consumes: `ooo_until`, `action_dismissed_at`, `action_permanently_dismissed`, `needs_action`, `last_inbound_at`, `last_outbound_at`, `has_future_meeting`, `stage`, `nurture_mode`, `nurture_status`, `automation_mode`, `warmingUpIds`, `nurtureIds`. **None of these are intent.**

If the queue UI applies an additional intent-based hide (e.g. "hide rows
whose latest inbound has intent=calendar_accept"), the `Action Required`
tab badge will overcount: it'll claim there are 12 actions but the user
will only see 7.

**C. Smallest fix:**

- **Phase 1:** the queue is a separate page, NOT the CommandStrip tab. Counts there can be computed independently from the filtered query result.
- **Phase 2:** if/when intent filtering lands in `classifyRevenueState`, pass intent up through `EnrichedLead` and update the classifier. Counts auto-fix because they're derived from the same classifier.
- This belongs in **Phase 2** and is mostly a UI hygiene item.

---

## 11. Time zones — eligible_at rendering

**A. Verified no user-visible rendering of `eligible_at` today.** Existing
UI uses it only for comparisons, not display.

**B. Where the logic lives:**

- [PriorityActions.tsx](src/components/dashboard/PriorityActions.tsx) never renders `eligible_at`. It displays `next_action_label` (a static string like "Reply to customer", "Send follow-up Email 2"). Grep confirmed.
- [dashboard/BulkAutomationDialog.tsx:65, 92, 130](src/components/dashboard/BulkAutomationDialog.tsx:65) — uses `eligible_at` to set state via `.toISOString()`.
- [dashboard/LeadTable.tsx:859, 1001–1002](src/components/dashboard/LeadTable.tsx:859) — uses `eligible_at` only in comparisons / boolean checks (`hasEligibleAt = !!lead.eligible_at`).
- No `eligible_at.toLocaleString/toLocaleDateString` calls anywhere in `src/`.
- `eligible_at` IS persisted as a UTC ISO timestamp by `deriveAction()` ([_shared/syncEngine.ts:404, 422, 444, …](supabase/functions/_shared/syncEngine.ts:404)). When the action queue eventually renders it (e.g. "fires at 4:30pm"), it'll default to **browser TZ** unless explicitly converted.
- Workspace timezone IS available: `workspaces.timezone` column added in [migrations/20260430200000_workspace_timezone.sql](supabase/migrations/20260430200000_workspace_timezone.sql) per PROGRESS.md line 47. Already used by the send-window guard. Not currently surfaced to React.

**C. Smallest fix:**

- **Phase 2:** when the queue starts rendering `eligible_at` ("Fires in 3h", "Eligible at 9:30 AM"), wrap the formatter to read workspace tz from `WorkspaceContext` and convert. Single helper, used everywhere.
- **KNOWN_ISSUES.md** until then — note that today nothing displays `eligible_at`, so there is no TZ bug yet; this is a *risk for the new UI*, not an existing one.

---

## 12. Backfill concurrent-write safety

**A. Verified real risk if backfill UPDATE is naive. Easily mitigated.**

**B. Where the logic lives:**

- No backfill exists yet — this is forward-looking for Phase 1.
- A naive `UPDATE lead_timeline_items SET intent='X' WHERE id=$1` would clobber a concurrent live write that already set intent during sync.
- Postgres provides the standard mitigation: `UPDATE ... WHERE intent IS NULL` makes the write idempotent and last-writer-loses to live data. The schema does not currently have an `intent` column, so this is a property of the migration we ship.

**C. Smallest fix:**

- **Phase 1 migration / backfill script:**
  ```sql
  UPDATE lead_timeline_items
  SET intent = $classified_intent
  WHERE id = $row_id
    AND intent IS NULL;  -- guard
  ```
  Always include the `intent IS NULL` guard. Two more belt-and-braces additions worth considering:
  - Add a unique partial index or trigger that rejects an UPDATE if the row's `updated_at` is newer than the backfill job's snapshot timestamp (overkill for V1).
  - Run the backfill in batches of ~500 with a small sleep to avoid lock contention with live syncs.
- Belongs in **Phase 1** but it's a one-line guard, not a phase.

---

## 13. Deleted lead during backfill — RLS / cascade

**A. Verified low risk.** Cascade deletes are clean and the backfill just
sees missing rows on the next iteration.

**B. Where the logic lives:**

- [migrations/20260324154224_…sql:9](supabase/migrations/20260324154224_5c08870b-2f6c-49b1-8d26-ed8ff3e614f7.sql:9):
  `lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE`. Lead deletion removes timeline rows automatically.
- RLS policy "Service role full access on lead_timeline_items" ([migration line 60–65](supabase/migrations/20260324154224_5c08870b-2f6c-49b1-8d26-ed8ff3e614f7.sql:60)) gives service role full RW. A backfill running with service-role auth doesn't get RLS surprises.
- The "lead deleted between SELECT and UPDATE" race shows up as `UPDATE … WHERE id=$1` affecting 0 rows. No error, no data loss, just wasted work.

**C. Smallest fix:** None. Backfill loops should treat 0-row UPDATE as a soft skip and move on. Worth a sentence of inline comment when we write the backfill script.

---

## 14. Detector evolution — versioning

**A. Verified gap.** No detector/classifier version anywhere in code or
schema.

**B. Where the logic lives:**

- Grep for `classifier_version|detector_version|version_classif` → 0 matches.
- All current detectors (`oooDetection.ts`, `meetingConfirmation.ts`, `unsubscribeDetection.ts`, inline bounce rules) are pure functions with no versioned config. Their version is implicit in the git SHA.
- When we add the `lead_timeline_items.intent` column, there's no `intent_version` column proposed to track which iteration of the classifier produced the verdict.

**C. Smallest fix:**

- **Phase 1:** add `intent_version int NOT NULL DEFAULT 1` alongside `intent`. Bump it whenever the classifier prompt or heuristic rule set changes materially. The cleanup script that runs "reclassify rows where `intent_version < $current`" then becomes trivial.
- Alternatively use `intent_classified_at timestamptz` and compare against a workspace-config "minimum classifier date" — slightly more flexible but more bookkeeping.
- **Phase 1**, but cheap.

---

## Summary

| # | Edge case | Verdict | Owner phase |
|---|---|---|---|
| 1 | OOO ∧ meeting precedence | Verified real (stale `hasFutureMeeting` bug) | Phase 2 |
| 2 | AI failure during sync | Verified — wrap in try/catch or move out-of-band | Phase 1 (wrap) / Phase 2 (out-of-band) |
| 3 | Mark-handled ↔ inbound race | Verified no risk | — |
| 4 | Meeting accept + question | Verified real — body never inspected | Phase 2 |
| 5 | Same email on multiple leads | Verified real — token-burn risk if backfill is row-keyed | Phase 1 |
| 6 | SaaS auto-reply false positives | Real but bounded | KNOWN_ISSUES |
| 7 | Silent send failures | Verified — gmail-send OK; outlook-send has Sent Items capture-miss risk | KNOWN_ISSUES |
| 8 | Snooze + inbound + classify order | Verified no risk if classification wrapped | Phase 1 (placement decision only) |
| 9 | "Why is this back?" UI | Verified gap | Phase 2 |
| 10 | CommandStrip count accuracy | Verified — counts unaware of intent | Phase 2 |
| 11 | Time-zone rendering of `eligible_at` | No current bug; risk for new UI | Phase 2 / KNOWN_ISSUES |
| 12 | Backfill concurrent-write safety | Easy mitigation | Phase 1 (one-line guard) |
| 13 | Deleted lead during backfill | Verified low risk | — |
| 14 | Detector versioning | Verified gap | Phase 1 (cheap column) |

**Verified real risks (act on):** #1 stale variable, #2 wrap-or-move classifier, #4 body-aware meeting detector, #5 dedupe backfill by content not row, #9 resurfacing UI, #10 count parity, #12 IS NULL guard, #14 intent_version column.

**False alarms / verified no risk:** #3 snooze race, #13 cascade.

**Needs runtime testing to confirm magnitude:** #6 SaaS false-positive rate (regex headers in the wild), #7 outlook Sent Items capture miss rate (need a 30-day log scan for `mail.outlook.sent_items_capture_missed`), #11 (only after we actually render `eligible_at` somewhere).

**KNOWN_ISSUES.md candidates:** #6 SaaS false positives, #7 outlook capture miss, #11 TZ until rendered, #9 if not scheduled.
