# AUDIT_REPORT.md — DrivePilot full read-only audit

**Date:** 2026-07-03 · **Repo:** `C:\Dev\DrivePilot` (github.com/sbenchmuel-sys/leadrocketai)
**Scope:** last 50 merged PRs (#78–#134) + full codebase sweep (dead code, unwired features, bugs, duplication/drift, safety-critical). No code was modified; this file is the only output.

> **Read this first — audit basis.** The working tree is checked out on the **stale branch `feat/todo-quick-actions`** (HEAD `b8c4bab`, ~PR #108 era, 2026-06-23). It does **not** contain PRs #110–#134. **Every finding below was verified against `origin/main` (tip `ff6589b`/`293865f`, 2026-06-30) via `git show`/`git grep`.** Line numbers refer to origin/main. Anyone who builds or deploys from the current checkout ships without PRs #110–#134 — that is itself the highest-leverage operational risk here (see §3, OPS-1).

---

## 1. Executive summary

- **PRs (50):** 47 WIRED · 1 PARTIALLY WIRED (#94 LinkedIn) · 1 SUPERSEDED (#124, stronger replacement) · 1 NOT WIRED (#79 scorecard RPC — orphaned).
- **Bugs:** 1 critical · 6 high · 6 medium · 3 low (after verification; 1 reported "critical" cron-dispatcher finding was a **stale-tree false positive** and was dropped — PR #111's auth gate is present on main).
- **Safety-critical:** no confirmed cross-tenant leak, wrong-send, or double-send **on the automated cold path** (guards traced sound). Real gaps: manual/Inbox send paths bypass all guardrails; Outlook unsubscribe under-detects; bulk-sync bounces are always treated as hard.
- **Dead code:** ~13,000–14,700 LOC removable (≈8k app code, ≈2.2k unused shadcn/ui, ≈0.7k safe edge functions, plus one-off ops scripts). Biggest single item: `LeadTable.tsx` (1,327 LOC) + its orphaned Dashboard cluster.
- **Duplication/drift:** client↔server campaign resolver diverges in ≥6 behaviors; two mail-connection stacks mounted at once; three legacy-`interactions` read paths will break at table cutover.
- **Category × severity (bugs+safety, deduped):** Critical 1 · High 8 · Medium 8 · Low 6.

---

## 2. PR wiring table (all 50)

Verdicts against `origin/main`. Evidence quotes abbreviated; see per-PR notes below the table for the non-WIRED cases.

| PR | Title (short) | Verdict | Key evidence (origin/main) |
|----|---------------|---------|----------------------------|
| 134 | gmail-bulk-sync: backfill old threads | WIRED | gmail-bulk-sync/index.ts:432 `DISCOVERY_MAX=200`, staleness gate :734 |
| 133 | One-pager offer in emails (gated) | WIRED | coldOutreach.ts:302 `resolveOnePagerInBody`; executor passes ctx :1894 |
| 132 | Upload-first campaign collateral | WIRED | CampaignDetail.tsx:750 `<CampaignCollateralSection>`; migration 20260629000000 |
| 131 | Value-led cold templates (de-AI) | WIRED | ai_task/index.ts:2168 campaign-authoring template contract |
| 130 | Motion-aware starters | WIRED | starterCadences.ts motion tags; `hidden:true` on Re-engage :234 |
| 125 | gmail-bulk-sync workspace-aware | WIRED | index.ts:1433 `.eq("workspace_id", explicitWorkspaceId)` |
| 124 | outlook bulk-sync workspace scope | SUPERSEDED | replaced by stronger lead-row guard outlook-sync/index.ts:141-150 |
| 123 | docs: cadence editor known gaps | WIRED | KNOWN_ISSUES.md:575 (nit: names wrong RPC — see notes) |
| 122 | manual email "Refresh" | WIRED | Leads.tsx:423 → useMailSync.ts:615 → gmail-bulk-sync:1384 |
| 121 | editable saved-draft cadence | WIRED | campaignQueries.ts:328 `replace_campaign_steps_reconciled` |
| 120 | gmail-sync bounded-parallel fetch | WIRED | gmail-sync/index.ts:473 `mapWithConcurrency(...,6)` |
| 119 | starter hints + send-floor surface | WIRED | StarterCadencePicker "Best for:"; floor at CampaignDetail:432 |
| 118 | "I handled this" + WhatsApp/SMS | WIRED | LeadDetailHeader.tsx:65 `resolveLeadQuickActions` |
| 117 | "Log a meeting" on card | WIRED | LogMeetingDialog.tsx:61 `post_meeting_recap` |
| 116 | per-step include_meeting_cta at gen | WIRED | coldOutreach.ts:169 `resolveStepMeetingCta` |
| 115 | edit starter before saving | WIRED | NewCampaign.tsx:160 `starterToDraftSteps` (no DB write on pick) |
| 114 | full cadence touch editor | WIRED | NewCampaign.tsx:192 add/move/insert; migration 20260624000000 |
| 113 | starter cadence library | WIRED | starterCadences.ts 3 cadences via `createCampaignWithSteps` |
| 112 | slim the right rail | WIRED | LeadOverviewPanel/AutomationToggleCard; compact mode |
| 111 | cron-dispatcher auth + 11 targets | WIRED | cron-dispatcher/index.ts:66 `requireScheduledCaller` |
| 110 | clean the conversation list | WIRED | TimelineTab.tsx:17 `timelineDisplay` helpers |
| 108 | To-do Reply/Follow-up + bulk Draft | WIRED | TodoView.tsx:337 `openComposer` → EmailActionDialog |
| 107 | revert dead manager-scope exemption | WIRED | dashboardMetricsService.ts:82-87 comment + admin-only |
| 106 | replied leads drop out of Automation | WIRED | leadStatus.ts:63 `isInAutomation` |
| 105 | 25-at-a-time pagination | WIRED | Leads.tsx:78 `LEADS_PAGE_SIZE=25` + ShowMoreFooter |
| 104 | QA sandbox bootstrap | WIRED | scripts/qa/sandbox-bootstrap.sh |
| 103 | Unit 1 spine — status line + Draft it | WIRED | LeadDetailHeader.tsx:53 `getLeadStatusLine` |
| 101 | To-do view on merged Leads page | WIRED | Leads.tsx:440 `<TodoView>` → `fetchQueueLeads` |
| 100 | Dashboard→Leads merge + mgr scoping | WIRED | App.tsx:83 dashboard→leads redirect; mgr scope :118 |
| 99 | gmail-bulk-sync dual-mode cron auth | WIRED | index.ts:1355 `isInternalCaller||isServiceRoleToken` |
| 98 | staging UI login helper | WIRED | scripts/qa/staging-login.mjs:72 staging-ref hard-abort |
| 97 | Step-3 recipient search + select-all | WIRED | NewCampaign.tsx:60 `filterLeads`, :527 select-all |
| 96 | flyer + LinkedIn test scenarios (docs) | WIRED | STAGING_TEST_PLAN.md:185 |
| 94 | LinkedIn as cadence channel | **PARTIALLY WIRED** | backend/runtime complete, **no UI selects it** (see notes) |
| 93 | flyer upload + honest copy | WIRED | NewCampaign.tsx:285 `ingestCampaignKnowledge` |
| 92 | automation notes → canonical ledger | WIRED | automation-executor:197/696 `createCanonicalInteraction` |
| 91 | cold auto-send guardrail tests | WIRED | coldSendFloorRules + coldTouchClaim tests present |
| 90 | lean staging docs + Vercel SPA config | WIRED | vercel.json SPA rewrite |
| 89 | soft vs hard bounce classification | WIRED* | gmail-sync/outlook-sync only — **bulk paths NOT covered (BUG-H3)** |
| 88 | CI type-check in build mode | WIRED | ci.yml `tsc -b --noEmit` |
| 87 | reply-stop re-anchor + warm exclusion | WIRED | `repliedSinceEnrollment` at all 4 sites |
| 86 | CI: vitest + tsc + build + Deno | WIRED | .github/workflows/ci.yml |
| 85 | automation_mode on EnrichedLead | WIRED | dashboardUtils.ts:329 |
| 84 | OAuth token encryption fail-closed | WIRED | encryption.ts:16 throws w/o key; all 15 writers use `encryptToken` |
| 83 | test-script wiring + RLS harness | WIRED | package.json:12-15; setup.ts:40 staging guard |
| 82 | prompt consolidation into SYSTEM | WIRED | prompts.ts:51 canonical BANNED PHRASES |
| 81 | Enrich from email | WIRED | LeadContextPanel.tsx:294 `extract-lead-profile` |
| 80 | collateral asset storage foundation | WIRED | wired further than promised (approval gate + link both landed) |
| 79 | campaign scorecard rollup RPC | **NOT WIRED** | RPC + client wrapper exist; **zero importers** (orphaned) |
| 78 | live send grounds in campaign KB doc | WIRED | automation-executor:1024 `validateCampaignKnowledgeDoc` |

**Per-PR notes (non-WIRED / material nuance):**

- **#94 (PARTIALLY WIRED).** Every backend layer is present and consistent — `channels.ts` type, `campaignDefaults.ts` LinkedIn touches, `ai_task` task routing, Queue runtime in `OutreachCard.tsx`. But `NewCampaign.tsx` `OPTIONAL_CHANNELS` (lines 52–55) offers only voice + sms; there is **zero occurrence of "linkedin" in the wizard**, and `getAvailableChannelsForLead` hard-codes `linkedinOk=false`. Net effect: unselected channels fall back to email, so every LinkedIn touch becomes an email — the entire LinkedIn path is unreachable except via direct DB writes. The "separate UI unit" the PR anticipated never landed. Leftover `apply_linkedin2.py`/`apply_linkedin3.py` sit in repo root.
- **#124 (SUPERSEDED — not a regression).** The PR's mechanism (bulk forwards `workspace_id`, `outlook-sync` scopes to it) was replaced by a stronger design: `outlook-sync` now ignores the body `workspace_id` and derives the workspace from the RLS-scoped lead row + an explicit current-membership check (`:141-150`), resolving the mailbox strictly inside `leadData.workspace_id`. Isolation is preserved and strengthened. Cleanup only: the now-ignored `workspace_id` field + stale comment in the bulk call.
- **#79 (NOT WIRED).** `get_campaign_scorecard` RPC (migration 20260610120000, granted to `authenticated`) and client wrapper `campaignScorecardQueries.ts` are healthy but **imported by nothing** (grep across `src/` on main). Promised follow-up (PR 5.2 Insights UI) never merged. Deployed dead weight — either build the UI or drop the wrapper + RPC.
- **#123 nit:** KNOWN_ISSUES names the RPC `edit_campaign_steps`; the real one is `replace_campaign_steps_reconciled`. Doc-only drift.
- **#89 caveat:** classification landed only in `gmail-sync`/`outlook-sync`. The **bulk-sync and outlook-webhook** bounce paths still treat every bounce as hard — see BUG-H3.

---

## 3. Bugs by severity

Severity: **critical** = data loss / cross-tenant leak / wrong or double email send; **high** = feature-breaking or a plausible path to critical; **medium** = degraded; **low** = latent. Tags: **NEW** (not in BUGS.md/KNOWN_ISSUES.md) · **KNOWN** (already tracked).

### Critical

- **BUG-C1 [NEW] — `structuredCampaign` referenced out of block scope in the executor legacy send path.** `automation-executor/index.ts:1450` `let postSendCampaign = structuredCampaign;` reads a `let` declared at `:1003` inside the "no cached draft" `else` block that **closes at `:1208`** (`} // end else (no cached draft)`). The read at 1450 is in the outer per-lead loop scope. Supabase deploys edge functions without type-checking (esbuild strips types), so this ships as a **runtime ReferenceError after the email has already been sent and the claim upgraded to `sent`**. Control jumps to the per-lead catch (`:1546`): the POST-SEND STATE UPDATE never runs — `needs_action`/`next_action_key` don't advance, `last_outbound_at` isn't stamped (breaks min-gap), nurture counters/volume-tripwire skip the send. *Failure scenario:* any lead whose send goes through this legacy branch has its sequence die after step 1, and the send is double-counted as `failed`. **Verified on origin/main by brace/indent trace.** Caveat: fires only if the legacy text-parse branch executes for a live lead (much cold traffic goes through `sendColdEmailTouch`); confirm reachability before sizing, but the scope error itself is unambiguous.

### High

- **BUG-H1 [NEW] — Outlook unsubscribe detection under-matches; Gmail catches 9 phrases, Outlook 3.** `outlook-sync/index.ts:577` uses an inline 3-pattern regex (`stop emailing` | `remove me` | `please don't/do not/stop email/contact/reach`), while `gmail-sync/index.ts:819` calls the shared `isHumanUnsubscribeRequest` (which also matches the bare word "unsubscribe", "opt out", "take me off", "no more emails", "stop contacting me"). *Failure scenario:* an **Outlook** lead replying "unsubscribe" or "opt out" is **not** flagged `unsubscribed`, and automation keeps emailing an opted-out contact — a CAN-SPAM/compliance breach on one provider only. (Distinct from the 2026-06-08 quoted-thread false-*positive* fix; this is a false-*negative* gap.) *Fix direction:* import `isHumanUnsubscribeRequest` into outlook-sync.
- **BUG-H2 [NEW] — Manual/Inbox send paths bypass every guardrail automation enforces.** `ReplyComposer.tsx:238`, `EmailActionDialog`/`SendEmailButton` via `useMailSync` → `gmail-send`/`outlook-send`. None check `leads.unsubscribed`, the `campaign_suppression_list`, dedup, or append the unsubscribe footer, whereas `automation-executor` (stop-conditions, late consent re-check, footer, dedup) and `coldOutreach.ts` do. *Failure scenario:* a rep can send from the Inbox to an `unsubscribed=true` / suppressed lead with no warning; a double-click or retry can double-send (no dedup on the manual path).
- **BUG-H3 [NEW] — Bulk-sync & Outlook-webhook treat every bounce as a hard bounce.** `gmail-bulk-sync/index.ts:571` (`if (isBounce) { unsubscribed:true, nurture_status:"inactive" }`) and `outlook-webhook/processor.ts` call **no `classifyBounce`** (grep count 0 vs 3 in gmail-sync). *Failure scenario:* a transient 4.x.x DSN (mailbox full, greylisting) permanently unsubscribes a good lead. The Outlook webhook is the always-on path for Outlook tenants. PR #89's soft/hard split was never extended to these two paths.
- **BUG-H4 [NEW] — Executor SMS steps never send: legacy candidate query omits `phone`.** `automation-executor/index.ts:268` `.select(...)` lists no `phone` (nor `whatsapp_number`), but `:1283` gates on `if (!lead.phone)` and `:1299` sends `to: lead.phone`. *Failure scenario:* every `channel==="sms"` step logs "No phone number", skips, and re-selects forever — SMS automation sends for nobody.
- **BUG-H5 [NEW] — Stale-claim recovery can free a slot for an already-sent email → duplicate send.** Recovery sets `status:"expired"` (`:147`) for claims stuck in `claiming` past the 10-min TTL; the unique index is partial `WHERE status IN ('claiming','sent')` (migration 20260326125531), and the send-dedup guards only count `sent`. *Failure scenario:* the executor is killed between provider success and the claim→`sent` upgrade (`:1383`) — realistic given 30–90s/send staggering vs the dispatcher's 55s abort and edge wall-clock limits. 10 min later the claim expires, nothing recorded the send, the next run re-claims the same lead+action+day and **sends the same email twice**.
- **BUG-H6 [NEW] — `campaign-touch-scheduler` touch transition is a non-atomic check-then-act.** `:214` re-reads `fresh.status !== "scheduled"`, then `:226`/`:243` `update({status:"queued"}).eq("id", t.id)` with **no status in the WHERE** (contrast `:359` which correctly does `.eq("status","active")`). *Failure scenario:* an overlapping scheduler run (or the executor) advances/skips the touch in the gap; this run overwrites it back to `queued`, resurfacing a Queue card for a touch the cadence already passed → rep sends a duplicate/out-of-order touch.

### Medium

- **BUG-M1 [NEW] — gmail-bulk-sync ignores Gmail search pagination.** `:345` builds `&maxResults=${maxResults}` (default 20) and reads `searchData.messages` with **no `nextPageToken` loop** — leads with >20 matching messages get only the newest page; stage/metrics derived from an incomplete record. (PR #134 raised discovery caps but this search stays single-page.)
- **BUG-M2 [NEW] — Bulk/webhook hard bounces never stamp `campaign_enrollment.bounced_at` or clear pending touches.** No equivalent to gmail-sync:579-608. *Failure scenario:* bounces via bulk/webhook are invisible to the bounce-rate circuit breaker → a blast to a rotten list keeps sending instead of auto-pausing; dead leads' touches linger in the due-query.
- **BUG-M3 [NEW] — Workspace auto-provision is non-atomic check-then-act.** `WorkspaceContext.tsx:157-167` inserts a workspace after a membership lookup returns none. *Failure scenario:* two tabs / StrictMode double-mount both insert → the user owns two workspaces, and tabs may bind different `workspace_id`, splitting leads/settings across tenants.
- **BUG-M4 [NEW] — `ReplyComposer` lead-fields fetch has no cancellation/ordering guard.** `:57-65` `useEffect([leadId])` with no cleanup, no `.catch`. *Failure scenario:* fast conversation-switching lets a slow earlier response resolve last, leaving the previous lead's email/phone/opt-in in state — `availableChannels` then offers channels from the wrong lead in a composer that sends real messages.
- **BUG-M5 [NEW] — `useBackgroundDraftQueue` duplicate-guard reads async React state.** `:31-45` `if (queue.get(leadId)?.status === "generating") return;` reads render-time state before the `setQueue` commit. *Failure scenario:* a double-click starts two `streamDraft` pipelines for one lead — duplicate AI spend, second result overwrites first.
- **BUG-M6 [KNOWN] — Outlook Sent-Items capture miss.** `outlook-send` `lookupSentMessageId` can write `gmail_message_id=null` on a 200 send and only `logger.warn`. Tracked in KNOWN_ISSUES (Phase 2.5 scan).
- **BUG-M7 [KNOWN] — `intent_router` writes a granular vocabulary not in the migration's documented list**, and returns no confidence score. Tracked in KNOWN_ISSUES (Phase 2a follow-up); no CHECK constraint yet, so currently a doc gap.

### Low

- **BUG-L1 [NEW] — Floating promise: `captureWinningInteraction({...})` invoked without `await`** in `gmail-sync:699` and `outlook-sync:508` (async → `Promise<void>`). Edge runtime can terminate before the insert commits → style-promotion "winning interactions" intermittently lost.
- **BUG-L2 [NEW] — Silent delete errors reported as success** in `message-cleanup/index.ts:68-73` and `intelligence-queue-drain/index.ts:60-64,114-119` (error never destructured, returns `ok:true`). Cleanup can silently stop working (log bloat, exhausted-row retries) with monitoring green.
- **BUG-L3 [NEW] — OAuth popup poll interval never cleared on unmount** in `useReconnectMail.ts:116-122` (`setInterval` cleared only inside `popup.closed`). Fires `setState`/`onComplete` against an unmounted component.

**Dropped after verification:** the two sweep agents' "cron-dispatcher is completely unauthenticated" **critical/high is a stale-tree false positive** — on origin/main `cron-dispatcher/index.ts:66` calls `requireScheduledCaller` (PR #111). Safety-agent finding #9 independently confirms every other `verify_jwt=false` function self-authenticates.

---

## 4. Dead code (evidence + LOC removable)

All re-verified against origin/main by real-import (not comment) checks. **Correction:** the dead-code sweep ran on the stale tree and wrongly flagged `collateralAssets.ts` — it is **live** (imported by `CampaignCollateralSection.tsx`, PR #132). Excluded below.

**App code — high confidence (~8,000 LOC):**
- **Orphaned Dashboard cluster** (dead since `/app/dashboard`→`/app/leads` redirect; `Queue.tsx` does **not** import `LeadTable` — verified, comment only): `pages/Dashboard.tsx` (349), `dashboard/LeadTable.tsx` (**1,327** — largest), `PriorityActions.tsx` (343), `BulkAutomationDialog.tsx` (316), `BulkMoveToNurtureDialog.tsx` (281), `NurtureSwitchDialog.tsx` (162), `CampaignSettingsPanel.tsx` (138), `SourceDropdown.tsx` (126), `ModeDropdown.tsx` (123), `AIInsightPanel.tsx` (120), `LeadAvatar.tsx` (66), `CommandStrip.tsx` (56), `TopMovers.tsx` (150)+test. **Note:** `leadEligibility.ts` (66, `categorizeForNurtureMove`) is imported only by the dead `BulkMoveToNurtureDialog` — so the Phase 1.5 bulk-move-to-nurture **eligibility guard is no longer mounted anywhere**. Confirm the live Leads page has an equivalent before deleting (may be a lost safety feature, not just dead code).
- **Other dead components/hooks/libs:** `admin/LastMileReasoningPanel.tsx` (340) + its unused `admin_tuning` flag [KNOWN], `settings/UnmatchedMeetingSummariesCard.tsx` (306), `settings/MatchedMeetingSummariesCard.tsx` (301), `lead/EmailTemplateSelector.tsx` (199) + `data/emailTemplates.ts` (439), `inbox/IntelligencePanel.tsx` (198), `leads/LeadCard.tsx` (185), `lead/MeetingPackHeader.tsx` (111), `onboarding/WelcomeStep.tsx` (51), `NavLink.tsx` (29), `AuthDebugPanel.tsx` (24) [KNOWN].
- **Dead hooks/libs:** `hooks/useGmailSync.ts` (421), `hooks/useGmailAutoSync.ts` (88) [KNOWN, CLEANUP.md], `hooks/useAutomationPoller.ts` (78), **`lib/mailProviders/` entire dir (280)** — the intended canonical send funnel, imported nowhere (see DRIFT-6), `schemas/llmOutputSchemas.ts` (229), `lib/draftValidator.ts` (192, client copy; the `_shared` one is live), `lib/actionRouter.ts` (168), `prompts/analyticsPrompts.ts` (142), `lib/dashboardStateCache.ts` (114), `lib/campaignScorecardQueries.ts` (78, = PR #79 orphan), `lib/ai/emailQualityScore.ts` (77), `lib/leadFilters.ts` (71), `lib/eligibleAtFormat.ts` (131)+test (WorkspaceContext reference is a doc-comment only — genuinely orphaned), `prompts/intentRouter.ts` (48).

**Unused shadcn/ui scaffold — low value, high confidence (~2,190 LOC):** `sidebar` (638), `chart` (304), `carousel` (225), `menubar` (208), `context-menu` (179), `navigation-menu` (121), `breadcrumb` (91), `drawer` (88), `pagination` (82), `input-otp` (62), `calendar` (55), `avatar` (39), `resizable` (38), `hover-card` (28), `progress` (24), `aspect-ratio` (6), `use-toast` (4). Deleting also lets you drop `embla-carousel`, `recharts`, `input-otp`, `react-resizable-panels`, `vaul`.

**Edge functions — safe candidates (~720 LOC):** `accept-workspace-invite/` (107, zero refs; accept is done client-side in WorkspaceContext), `twilio-voice-outbound/` (187, browser SDK path is live instead), `decrypt-messages/` (146, zero refs — an unused decrypt endpoint is pure attack surface), `automation-check/` (65, comment-only refs), `outlook-bulk-sync/` (212, **built but never dispatched** — not in cron ALLOWED_TARGETS → Outlook tenants get no bulk backfill; wire it or delete).
**Confirm-then-delete (one-off ops, ~1,770 LOC):** `classify-timeline-intent-backfill/` (355), `classify-timeline-intent-sample/` (325), `backfill-inbound-drain/` (198)→`backfill-inbound-summaries/` (888).
**Do NOT delete without dashboard check:** `conversation-analyze/` (507) — no in-repo caller but sole writer of `conversation_analysis` rows the UI reads → **its trigger is an untracked dashboard cron; codify it into cron-dispatcher**. `ingest-crm-signals`/`ingest-website-signals` are external webhook endpoints by design.

**Stray root files — user files, confirm (~1,410 LOC):** `apply_linkedin{,2,3}.py`, `_ec*.mjs`/`_mig*.sql`/`_apply*.mjs`/`_verify.mjs` one-offs (**diff `_mig*.sql` for schema never captured in migrations**), `remediation_clear_false_unsubscribe_ryan.sql`, `status-update-*.md`.

**Assets:** `public/placeholder.svg` (unreferenced). Keep the `.well-known/` Microsoft files.

**DB tables:** none dead — all 69 tables have ≥1 live reader/writer (column-level audit not performed).

---

## 5. Unwired features (what's missing, or delete)

- **HIGH — 72h message-body purge is permanently disabled but the frontend still assumes it runs.** Migration 20260601122356 unschedules `dispatch-message-cleanup` + `expire-messages`; nothing reschedules. `queueQueries.ts:311` / `cleanBodyText.ts:13` still document the 72h purge as active. Bodies now retained indefinitely — reconcile with the public retention promise (ties to **BUG-005**, deferred). *Missing:* re-enable migration **or** remove purge machinery + correct the stale commitment. **KNOWN** (BUG-005/006 deferred).
- **HIGH — Compensating backfill never wired.** The same migration says surviving bodies "will be backfilled…by backfill-inbound-drain" — but nothing schedules/invokes it. Runs only if curled manually. **NEW.**
- **HIGH — Phantom cron: `gmail-background-sync-job` fires every 15 min at a nonexistent function on a *different* project ref** (`umqhdxjtgarwkdpwsxrm` vs current `ntzeiflqqluwgdfmatjh`), migration 20260106083245; never unscheduled. *Fix:* `cron.unschedule('gmail-background-sync-job')` migration. **KNOWN** (CLEANUP.md).
- **MEDIUM — "Invitation sent" toast but no email is sent.** `WorkspaceMembersCard.tsx:145` toasts after a bare insert into `workspace_invitations`; no mailer reads that table. Invitees are never notified. *Fix:* invite-email sender, or change copy. **NEW.**
- **MEDIUM — `/app/analytics` (ManagerAnalytics) is routed but unlinked** — `DashboardLayout` has a `managerOnly` nav field that no item uses; backing cron/`manager_views` are live. A lost nav link, not dead code — relink it. **NEW.**
- **MEDIUM — `offer_registry` has zero writers** → `ai_task/index.ts:724` always hits "No active offers configured". Build the management UI or delete the table + scoring code. **NEW.**
- **MEDIUM — Orphaned endpoints with no producer/consumer:** `automation-check`, `conversation-analyze` (trigger untracked — see §4), `ingest-crm/website-signals`, `outlook-bulk-sync`. See §4.
- **LOW — `match_knowledge_chunks` (v1) RPC superseded by v2**, uncalled — `DROP FUNCTION` migration. **NEW.**

---

## 6. Duplication / drift

- **CRITICAL→ now HIGH (BUG-H1) — Unsubscribe detection drift** (Outlook 3-pattern inline vs Gmail 9-pattern shared). Canonical: `_shared/unsubscribeDetection.ts`. See §3.
- **HIGH — Manual send paths bypass guardrails (BUG-H2)** and **ReplyComposer is a third drifted send path**: `ReplyComposer.tsx:238` hardcodes `gmail-send` regardless of provider and sets `subject: "Re: " + conversation.contact_name` (fabricated from the contact's *name*, breaking threading). An Outlook-only workspace replying from the Inbox hits gmail-send. Canonical: `useMailSync.sendEmail` (provider-aware). *Fix:* route ReplyComposer through it.
- **HIGH — Step-instruction scoping fix landed client-side only.** `src/lib/campaignResolver.ts:337` scopes instructions to the current step (`extractStepScopedInstructions`, the Codex-P1/PR-#50 fix); the **server** `_shared/campaignResolver.ts:444-445` legacy path still joins **all** steps' instructions (`[...global_rules, ...Object.values(step_instructions)]`) into the "MANDATORY" prompt block. The structured path (`:380`) is correctly scoped, but the legacy text path — used by live automation — leaks other steps' instructions into every email. *Fix:* port `extractStepScopedInstructions` into the server legacy path.
- **MEDIUM — Campaign resolver pair diverges in ≥4 more behaviors** (canonical = server): nurture-step-4 framework (`neutral_observation` client vs `breakup` server), CTA upgrade to `meeting_booking:<link>` (server only), "meeting already booked / lead replied" prompt warnings (server only), signals framework. Manual drafts (client) can ask for a meeting that's already booked or omit the calendar CTA that automation includes. *Fix:* extend the golden parity test and converge.
- **MEDIUM — Two mail-connection stacks mounted at once:** legacy `useGmailConnection`/`GmailConnectionCard` (Settings, onboarding; `gmail-callback` still writes `gmail_connections`) alongside current `useMailSync`/`mail_accounts`. `EmailActionDialog` runs both with a fallback chain — Settings can show "connected" from the legacy table while sends use a different source. Canonical: `mail_accounts`. Retire the legacy hook.
- **MEDIUM — Three legacy-`interactions` READ paths with no `lead_timeline_items` equivalent** will break at cutover: `gmail-sync:363` (dedup set), `outlook-sync:580,598` (meeting-follow-up metrics), `automation-executor:559-565` (multi-participant guard). Writes are already dual; re-point these reads before dropping `interactions`. Also `reset-demo:74` deletes `interactions` with no paired timeline delete (verify FK cascade). **KNOWN** (interactions→timeline cutover).
- **MEDIUM — Client vs server lead scoring** (`closingPowerUtils.ts` hand-tuned points vs `recompute-lead-intelligence` `engagement_score`) — the number a rep sees differs from what automation/AI use. Canonical: server (per CLAUDE.md). **KNOWN** (CLAUDE.md hazard).
- **LOW — `mailProviders/` funnel is dead (DRIFT-6):** the abstraction built to unify sends is imported nowhere; three send paths re-implement invocation. Either bless `useMailSync.sendEmail` as the single funnel and delete the dir, or wire everything through it.
- **LOW — stale mirror comments:** `_shared/bounceDetection.ts:4-12` still claims inline copies are authoritative (both sync fns now import `classifyBounce`); client resolver missing sms/voice constraint tables and a whatsapp step-1 rule.

**Verified in-sync (no action):** `draftValidator` client↔server (logic byte-equal), `isValidEmail`↔`isSendableColdEmail`, `automation_log` vs `automation_logs` (correct separate uses), OOO/bounce/defer/CAN-SPAM-footer/unsubscribe-token shared implementations.

---

## 7. Recommended cleanup order (small, separately-shippable PRs)

Ordered by risk-reduction per unit of effort. Each bullet is one PR.

**Tier 1 — correctness/compliance (ship first):**
1. **Deploy origin/main / fix the checkout (OPS-1).** The working tree is 100+ commits behind main; anyone building from it ships without PRs #110–#134. Re-sync before anything else.
2. **BUG-H1 — Outlook unsubscribe parity.** Import `isHumanUnsubscribeRequest` into `outlook-sync`; delete the inline regex. Small, high compliance value.
3. **BUG-H3 + BUG-M2 — bounce classification on bulk/webhook paths.** Route `gmail-bulk-sync` and `outlook-webhook/processor` bounces through `classifyBounce`; stamp `bounced_at` + clear pending touches on hard bounces.
4. **BUG-C1 — executor scope error.** Move the `structuredCampaign` declaration out to the per-lead loop scope (or re-load in the post-send block unconditionally). Confirm legacy-branch reachability while fixing.
5. **BUG-H5 + BUG-H6 — double-send windows.** Make the claim→sent upgrade resilient to expiry (record send before freeing the slot) and add `.eq("status","scheduled")` to the scheduler's touch update.
6. **BUG-H2 — shared pre-send guard for manual paths.** One frontend helper that checks `unsubscribed` + suppression + a confirm, consumed by ReplyComposer/EmailActionDialog/SendEmailButton; simultaneously route ReplyComposer through `useMailSync.sendEmail` (fixes DRIFT provider hardcode + fabricated subject).
7. **BUG-H4 — add `phone` (+`whatsapp_number`) to the executor candidate select.** One-line, unblocks SMS automation.

**Tier 2 — drift & safety hardening:**
8. **DRIFT — port step-scoped instructions to the server legacy resolver** (stop leaking other steps into prompts).
9. **Unschedule the phantom `gmail-background-sync-job` cron** + codify `conversation-analyze`'s trigger into cron-dispatcher (remove untracked dashboard crons).
10. **Reconcile the 72h purge** (re-enable + wire the backfill drain, or remove the machinery and correct the retention copy) — coordinate with BUG-005 owner.
11. **BUG-M3/M4/M5** — atomic workspace provision; ReplyComposer fetch cancellation; draft-queue guard via ref.

**Tier 3 — dead-code removal (mechanical, low risk, do after Tier 1 so diffs stay small):**
12. **Delete the orphaned Dashboard cluster** (`Dashboard.tsx` + `LeadTable.tsx` + 11 components, ~4k LOC) — **but first** confirm the bulk-move-to-nurture eligibility guard (`leadEligibility.ts`/`BulkMoveToNurtureDialog`) has a live equivalent on the Leads page; if not, that's a re-wire, not a delete.
13. **Delete dead hooks/libs** (`useGmailSync`, `useGmailAutoSync`, `mailProviders/`, `campaignScorecardQueries` unless #79's UI is built, `eligibleAtFormat`, etc.) and the CLEANUP.md-listed items (`AuthDebugPanel`, `admin_tuning` flag).
14. **Prune unused shadcn/ui** (~2.2k LOC) + drop the now-unused deps.
15. **Delete safe edge functions** (`accept-workspace-invite`, `decrypt-messages`, `twilio-voice-outbound`, `automation-check`) and decide `outlook-bulk-sync` (wire into cron or delete).
16. **Tidy root** (one-off `.py`/`.mjs`/`.sql` scripts, stale docs) after diffing `_mig*.sql` for uncaptured schema.

**Tier 4 — features to finish or cut:**
17. **#94 LinkedIn** — add the wizard channel option (finish the missing UI unit) or remove the dormant backend.
18. **#79 scorecard** — build the Insights UI or drop the RPC + wrapper.
19. **Relink `/app/analytics`** manager nav; decide on `offer_registry` (build UI or delete).

---

*Audit method: 5 PR-verification subagents (10 PRs each) + 5 codebase-sweep subagents (dead code, unwired, bugs, duplication, safety), all read-only, dispatched in parallel. Every critical/high finding was re-verified by the orchestrator against `origin/main` via git; findings that existed only in the stale working tree (notably the "unauthenticated cron-dispatcher" critical) were dropped. KNOWN/NEW tags cross-referenced against BUGS.md, KNOWN_ISSUES.md, and CLEANUP.md.*
