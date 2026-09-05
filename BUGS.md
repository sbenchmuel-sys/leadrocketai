# BUGS.md — centralized QA bug ledger

One place for every bug the QA agent (or anyone) finds. Claude Code: pick open bugs top-down by severity; each entry ends with a ready-to-use fix prompt. When you fix one, set status to `fixed` — the nightly QA run re-tests it and promotes it to `verified` (or reopens it).

**Severity:** P0 = wrong send possible / cross-dealership leak / broken public promise. P1 = core flow broken. P2 = degraded but usable. P3 = cosmetic.
**Status flow:** `open` → `fixed` (by Claude Code) → `verified` (by QA re-test) | `reopened`. `deferred` = deliberately not fixing now — do not pick up without reading the note.

---

## BUG-001 — mail_accounts login tokens may be stored unencrypted
- **Severity:** P0 (suspected — unconfirmed)
- **Status:** verified (2026-07-01, re-verified 2026-08-03, re-verified 2026-08-22) — all `mail_accounts` AND `gmail_connections` token writes now encrypt unconditionally and fail closed if `TOKEN_ENCRYPTION_KEY` is missing (previously they silently stored plaintext). New tests: `supabase/functions/_shared/encryption.test.ts` (helper behavior) + `src/test/mailAccountsTokenEncryption.test.ts` (static guard that fails `npm test` if any token write bypasses `encryptToken`). Legacy rows written while the escape hatch existed may still be plaintext — re-encryption backfill plan recorded in CLEANUP.md. **Pre-deploy check:** confirm `TOKEN_ENCRYPTION_KEY` is set in the live project; with the key absent, connect/refresh flows now fail visibly instead of storing plaintext. Code review 2026-08-22 confirms: `outlook-callback/index.ts` lines 223–226 call `encryptToken()` before upsert; 17 token-write paths verified using `encryptToken` helper; no plaintext write paths found.
- **Found:** 2026-06-11, staging data-safety run (EN-1/EN-2)
- **What happens:** Gmail and integration tokens are stored in clearly-encrypted fields, but the `mail_accounts` path stores its tokens in plain-looking columns. Table was empty on staging so actual contents couldn't be confirmed — but if real, this breaks the "OAuth tokens encrypted at rest" public commitment, likely in production too.
- **Repro:** Connect a mailbox through the `mail_accounts` path, then inspect the row — token columns should be AES-256-GCM ciphertext like the Gmail path, not readable values.
- **Where to look:** `supabase/functions/_shared/encryption.ts`; every code path that inserts/updates `mail_accounts`.
- **Claude Code prompt:** "Audit every write path to the `mail_accounts` table. Confirm whether access/refresh tokens are encrypted with the shared AES-256-GCM helper in `supabase/functions/_shared/encryption.ts` before storage. If any path stores plaintext, route it through the helper, add a migration note for re-encrypting existing rows, and add a unit test that fails if a plaintext token is ever written. Do not weaken any existing encryption."

## BUG-002 — Staging's scheduled job points at a different Supabase project
- **Severity:** P1 (staging only, but it may be quietly calling another live system)
- **Status:** fixed (2026-06-12, applied directly to staging via MCP — no repo migration on purpose: a committed migration with staging's URL/key would repoint PROD's crons at staging if ever applied there) — deleted `gmail-background-sync-job` (foreign project `umqhdxjtgarwkdpwsxrm`); created the full production cron set (12 jobs from the codify migrations) pointed at staging's URL + staging anon key. **`dispatch-automation-executor` is deliberately DISABLED on staging** (production sender; enable only for supervised send tests — note Eligible Ed now has full-auto consent per BUG-007). Caveat: staging has NO edge functions deployed yet, so these jobs 404 until the function suite is deployed there.
- **Found:** 2026-06-11, staging data-safety run
- **What happens:** The single pg_cron job on staging (email sync) targets `umqhdxjtgarwkdpwsxrm`, not staging's own URL (`jhipmqdpjenojfhfjgzq`). Likely copied setup. Side effect: nothing scheduled actually runs against staging, and an unknown project gets poked hourly.
- **Repro:** `SELECT jobname, command FROM cron.job;` on staging — the URL in the command doesn't match the staging project ref.
- **Claude Code prompt:** "On the staging Supabase project, update the pg_cron job command(s) to call staging's own functions URL with staging's anon key, following the codify-cron-jobs migration pattern. Also replicate the production cron set onto staging (message-cleanup, classify-inbound, cron-dispatcher targets) so retention and classification can be tested there. Keep the codified migration mirror in sync per CLAUDE.md."

## BUG-003 — ~~RLS isolation test not committed~~ WITHDRAWN
- **Status:** withdrawn 2026-06-11 — `src/test/integration/rlsIsolation.test.ts` and `setup.ts` are committed (`git ls-files` confirms). Initial report was based on stale info.

## BUG-004 — ~~No `test` script in package.json~~ WITHDRAWN
- **Status:** withdrawn 2026-06-11 — `test`, `test:watch`, `test:edge`, and `test:isolation` scripts all exist. (The QA sandbox mount had served a stale, truncated package.json — environment artifact, not a repo problem.)

## BUG-007 — Test personas can't prove a positive "Ed sends" case
- **Severity:** P2 (test-data gap on staging — the AE skip-list test passes *vacuously*)
- **Status:** fixed (2026-06-12, staging data) — Eligible Ed: `automation_mode='full_auto'`, `needs_action=true`, `next_action_key='send_pre_1'` (first cold-sequence step), `eligible_at` in the past, `manual_mode=false`. Verified with the executor's exact candidate filter (automation-executor/index.ts:260-271): returns exactly one row (Ed); the other five personas stay excluded. Safe because the staging executor cron is disabled (BUG-002) and no mailbox is connected.
- **Found:** 2026-06-11, staging regression sweep (check C)
- **What happens:** All six personas have `automation_mode = NULL` and `next_action_key = NULL`, so the automation-executor filter excludes *everyone* — including Eligible Ed. "Only Ed comes back" passes because nobody comes back; the test never proves Ed *would* be emailed when he should be.
- **Repro:** Run the executor's candidate filter on staging — empty result even after granting Ed `automation_mode='full_auto'`, because `next_action_key <> 'ooo_return_followup'` is NULL-valued for him.
- **Claude Code prompt:** "On the STAGING project only (`jhipmqdpjenojfhfjgzq`), update the seed for the 'Eligible Ed' test lead in Test Dealership B: set `automation_mode='full_auto'` and a real `next_action_key` (e.g. the first cold-sequence step) so the automation-executor's candidate filter selects exactly him. Re-run the filter to confirm exactly one row (Ed) returns and the other five personas remain excluded."

## BUG-008 — Staging migration ledger 175 migrations behind the repo
- **Severity:** P2 (audit/tracking drift, schema itself looks current)
- **Status:** fixed (2026-06-12, staging data) — back-filled 175 version rows into `supabase_migrations.schema_migrations` (now 208/208, newest = repo newest) with marker name `ledger-backfill 2026-06-12: objects verified present on staging, NOT re-executed`. Pre-verified 9 signature objects across the migration timeline (timeline_followup_state, campaign_enrollment/touch, lead_timeline_items, calendar_events, recent lead columns, match_knowledge_chunks_v2, set_timeline_followup_state, expire_old_messages) before asserting "applied". CLAUDE.md note about Lovable bypassing the ledger still pending (file was locked by an open editor) — drift checks must compare actual schema objects, not ledger rows.
- **Found:** 2026-06-11, staging regression sweep (check F)
- **What happens:** Repo has 208 migration files; staging's `schema_migrations` records only 33 (newest Feb 11). The live schema *does* contain the newer objects — Lovable applies SQL without recording it — so the ledger can't be trusted to answer "what's applied," and IaC replay/audit on staging is ambiguous.
- **Claude Code prompt:** "Reconcile staging's `supabase_migrations.schema_migrations` ledger: back-fill version rows for the repo migrations whose objects already exist on staging (do NOT re-execute them), or alternatively add a documented marker migration. Then add a note to CLAUDE.md that Lovable-applied SQL bypasses the ledger, so future drift checks compare actual schema objects, not ledger rows."

## BUG-009 — `automation_mode` missing from EnrichedLead/LeadListItem types
- **Severity:** P3 (type-level only; runtime behavior correct, tests pass)
- **Status:** verified (2026-07-01, re-verified 2026-08-03, re-verified 2026-08-22) — `automation_mode?: string | null` declared on `LeadDetail`, `as any` casts removed in `classifyRevenueState` + test. Code review 2026-08-22 confirms: `supabaseQueries.ts` lines 93–143 include `automation_mode` in both `LeadListItem` pick list (line 95) and `LeadDetail` type (line 134); type properly declared.
- **Found:** 2026-06-11, test-suite run (`tsc` project check)
- **What happens:** `classifyRevenueState` in `src/lib/dashboardUtils.ts` reads the consent gate via `(lead as any).automation_mode` — the field exists at runtime but was never declared on the type, producing 1 tsc error in `dashboardUtils.test.ts` and an `as any` cast in production code.
- **Claude Code prompt:** "Add `automation_mode` to the `EnrichedLead`/`LeadListItem` type(s), remove the `as any` cast in `classifyRevenueState` (src/lib/dashboardUtils.ts), and confirm `npx tsc -p tsconfig.app.json` is clean and the dashboardUtils tests still pass."

## BUG-010 — automation-executor system notes written only to legacy `interactions`
- **Severity:** P3 (migration hygiene during the `interactions` → `lead_timeline_items` cutover — NOT a leak, wrong-send, or broken public promise)
- **Status:** verified (2026-07-01, re-verified 2026-08-03, re-verified 2026-08-22) — both `automation-executor` system-note writes now go through `createCanonicalInteraction` (`_shared/canonicalInteraction.ts`), which inserts into `interactions` AND projects into the canonical `lead_timeline_items` ledger, so the notes survive once `interactions` is retired. Existing `dedupe_key` formats preserved. `workspace_id` added to the OOO query (~162) and candidate query (~262) selects so the projection actually fires. Code review 2026-08-22 confirms: OOO return (line 197–205) and unsubscribe stop (line 696–704) both call `createCanonicalInteraction` (canonical helper writes interactions + projects into lead_timeline_items).
- **Found:** 2026-06-18, nightly run (re-confirmed 2026-06-19).
- **Scope correction:** the nightly listed 4 orphan sites, but only 2 are real — `automation-executor/index.ts:193` (OOO-return note) and `:688` (unsubscribe-stop note). The other two it named (`call-analyze:503`, `whatsapp-send:193`) already project to `lead_timeline_items` via `projectTimelineItem`, as do all other cross-channel comms writes (gmail/outlook/sms/voice). Verified site-by-site against authoritative files.
- **What happens:** the two automation system notes did a bare `.insert()` into `interactions` with no timeline projection. When `interactions` is dropped, those rows (notably the unsubscribe audit note "Lead requested to unsubscribe — automation stopped permanently") would vanish from the lead timeline.
- **Repro:** grep edge functions for `from("interactions").insert` that has no adjacent `projectTimelineItem`/`createCanonicalInteraction` → the two automation-executor sites.
- **Claude Code prompt:** "Route the two automation-executor system-note inserts (lines ~193 OOO-return and ~688 unsubscribe) through `createCanonicalInteraction` so they also land in `lead_timeline_items`; preserve dedupe_key; add `workspace_id` to the source queries so projection fires."

## BUG-022 — CAN-SPAM postal-address block silently off since June; its test went stale and red
- **Severity:** P2 today (invited pilot only), P0 the day cold outreach opens up
- **Status:** fixed (2026-09-05, branch `fix/outreach-sprint-2`) — behaviour unchanged for the pilot, but no longer implicit.
- **Found:** 2026-09-05, running `npm run test:edge` for the Sprint 2 merge gate.
- **What happens:** `sendColdEmailTouch` used to refuse any cold email whose workspace had no physical postal address — the CAN-SPAM floor. Lovable commit `dfc2f6e` (2026-06-30) relaxed it to a code comment ("PILOT: allowed to be blank … re-enable the hard block before opening up") and the footer just omits the address line. `coldSendFloor.test.ts` (written 2026-06-21) still asserted the refusal, so `npm run test:edge` had been failing on `main` for 72 commits and nobody was reading it. `sendColdEmailTouch`'s own docblock still claimed the address was "required non-blank" and "cannot be bypassed".
- **Scope:** rep-approved review/manual sends only. AUTOMATIC sends have always required a postal address and still do (`campaign-touch-scheduler` + `automation-executor` gates), so no cold email has ever gone out automatically without one.
- **Fix:** the relaxation is now an explicit switch — `requirePostalAddress()` reads the edge-function secret `COLD_REQUIRE_POSTAL_ADDRESS`; only an exact "true" turns the refusal back on, so a typo leaves pilot behaviour rather than silently blocking every rep. Docblock corrected, both sides covered by tests, and the re-enable is tracked in CLEANUP.md as a pre-launch gate.
- **Still to do:** set `COLD_REQUIRE_POSTAL_ADDRESS=true` before cold outreach opens beyond invited pilot workspaces.

## BUG-016 — A logged call outcome didn't finish the step, and vanished on a mobile reload
- **Severity:** P2 (cadence stalls silently)
- **Status:** fixed (2026-09-04, Sprint 2 #6, branch `fix/outreach-sprint-2`)
- **What happens:** "Got them" / "No answer" only wrote `call_outcome`; the touch stayed `queued` until the rep ALSO tapped the ✓, which most never did, so the cadence sat on a call that had already been made. Worse, the buttons were gated on a local React flag set when the rep tapped **Call** — switching to the dialer and back reloads the mobile tab, so the flag (and the buttons) were gone by the time they had something to log.
- **Fix:** `set_call_outcome` now stamps the outcome, then claims + `advanceColdEnrollment` exactly like `mark_sent`; its branch moved BELOW the replied / inactive / opt-out backstops (it advances now, so it must pass the same guards) and is voice-only. Client-side the outcome buttons are always visible on a voice card — no local "did they tap Call?" state left to lose. Guard: `src/test/outreachLegibilityGuards.test.ts`.

## BUG-017 — Outreach tab silently capped at 50 cards, badge showed "50" for any backlog
- **Severity:** P2 (work invisible at scale)
- **Status:** fixed (2026-09-04, Sprint 2 #7, branch `fix/outreach-sprint-2`)
- **What happens:** `fetchOutreachQueue` hard-limited 50 rows and returned a bare array, so the tab badge counted the PAGE, not the backlog. A rep with 300 due touches saw "Outreach 50" and no way to reach the rest.
- **Fix:** the same query now carries `count: "exact"` (no extra round-trip) and returns `{ touches, total }`; the badge reads `total`, and a "Showing N of M · Show more" control grows the window a page at a time. `OUTREACH_SURFACE_CAP` → `OUTREACH_PAGE_SIZE`.

## BUG-018 — Auto-skipped steps left no trace anywhere the rep looks
- **Severity:** P2 (silent automated decision)
- **Status:** fixed (2026-09-04, Sprint 2 #9, branch `fix/outreach-sprint-2`)
- **What happens:** when the scheduler auto-skipped a manual touch (window expired, or the lead had no phone / LinkedIn URL), the step just disappeared and the cadence moved on. The only hint was an italic note in the Upcoming strip, and only for the missing-handle case.
- **Fix:** `advanceColdEnrollment` — the single choke point both auto-skip paths funnel through — writes a `system_note` timeline item naming the step and the reason (also in `metadata_json`, which survives the 72h snippet purge). The scheduler passes the reason via a new `opts.skipReason`. Per-campaign and per-person auto-skip counts now show on the campaign's People list (see BUG-019).

## BUG-019 — Campaign People list showed names and nothing else
- **Severity:** P3
- **Status:** fixed (2026-09-04, Sprint 2 #13, branch `fix/outreach-sprint-2`)
- **What happens:** no way to tell an untouched lead from one on step 7, one who replied, or one whose steps were being auto-skipped.
- **Fix:** `fetchCampaignCadence` + pure `deriveCadenceStatus` (tested in `src/lib/campaignCadenceStatus.test.ts`) render "Step 3 of 9 · Call · due Tomorrow 9:00 AM" per person, terminal states in plain words, and an auto-skip count per person and per campaign. Reads the enrollment cursor (+1), the same lock-step rule the sender uses — not the first unsent row.

## BUG-020 — Cadence due times rendered in the browser's timezone, and cards showed no step or due time
- **Severity:** P2 (two reps see different times for the same touch)
- **Status:** fixed (2026-09-04, Sprint 2 #10, branch `fix/outreach-sprint-2`)
- **What happens:** `UpcomingTouchesStrip.formatReadyAt` used `toLocaleTimeString`/`toDateString`, so "Today 9:00 AM" meant the viewer's clock; a rep in a different timezone from the workspace saw a different — and sometimes a different-DAY — due time. Outreach cards showed neither which step they were nor when the touch was due.
- **Fix:** `formatReadyAt` deleted; `formatDueAt` added to `eligibleAtFormat.ts` (the module that exists for exactly this), comparing calendar DAY KEYS in workspace time so Today/Tomorrow is right across timezones and DST. Outreach cards gained a "Step N · due …" line. Guard: no `toLocale*Time/Date` left in the cadence surfaces.

## BUG-021 — LinkedIn "Message" opened an empty compose window, not the person
- **Severity:** P2
- **Status:** fixed (2026-09-04, Sprint 2 #11, branch `fix/outreach-sprint-2`)
- **What happens:** the touch opened `linkedin.com/messaging/compose/` with no recipient — the rep had to search for the lead by hand after every LinkedIn message step.
- **Fix:** it opens the lead's profile (like Connect and React already did), where "Message" is one click and already addressed; the copied-message toast says so. LinkedIn has no supported URL that opens a composer addressed to someone.

## BUG-011 — Outreach touches dated from "Add people", not from Launch
- **Severity:** P1 (main path — root cause of "everything in the Queue is overdue")
- **Status:** verified (2026-09-03, code audit) — Launch now calls `launchCampaignWithSchedule` → `reanchorScheduleForLaunch` (re-runs the staggered-start drip from launch time for every not-started enrollment and UPSERTs its touch rows), then flips status, then promotes the first due cards. `promoteFirstDueTouches` no longer promotes for non-active campaigns. Test: `planRelaunch` cases in `src/lib/campaignEnrollment.test.ts`. Verified present in `src/lib/campaignEnrollment.ts` (commit f7f3b15).
- **Found:** 2026-09-02, outreach audit (see project doc `claude/outreach-audit-2026-09-02.md`)
- **What happens:** enrollment wrote `started_at = now` and every touch's `eligible_at` from it, even on a draft; `launchCampaign` only flipped status. Launching a day later made every step-1 touch already due → all cards flooded in at once, the drip was defeated, the Upcoming strip showed past times.

## BUG-012 — Automatic emails parked as review cards (wrong gate column)
- **Severity:** P1 (automatic mode never auto-sends the first / same-day-next email)
- **Status:** verified (2026-09-03, code audit) — `campaignEnrollment.ts:promoteFirstDueTouches`, `automation-executor/index.ts`, and `campaign-touch-scheduler/index.ts` all consistently use `cold_auto_send_enabled`. Guard test: `src/test/coldAutoSendGate.test.ts`. Verified in place (commit f7f3b15).
- **What happens:** the failed select read as "auto-send off" → email touch set to `queued` (review card); the executor only sends `scheduled` touches, so the email never left on its own.

## BUG-013 — Snoozing a manual touch auto-skips it
- **Severity:** P1 (silent data loss of the rep's intent)
- **Status:** verified (2026-09-03, code audit) — `outreach-touch-action` snooze shifts `max_age_at` by the same delta (floored just after the new due time); scheduler stale-queued sweep also requires `eligible_at <= now`. Logic verified in place (commit f7f3b15).
- **What happens:** snooze moved `eligible_at` only; the scheduler's stale sweep saw `max_age_at < now` and auto-skipped the card on its next 5-minute tick.

## BUG-014 — App hangs forever on the loading spinner
- **Severity:** P1 (reliability; observed live on drivepilot.app 2026-09-02)
- **Status:** verified (2026-09-03, code audit) — `AuthContext.authStalled` flips after 10s of loading; `ProtectedRoute` / `ProtectedOnboardingRoute` render `AuthStalledCard` (Reload / Sign in again, which clears `sb-*` local session keys). Verified in `src/contexts/AuthContext.tsx`, `src/components/AuthStalledCard.tsx`, `src/components/ProtectedRoute.tsx`, `src/components/ProtectedOnboardingRoute.tsx` (commit f7f3b15).
- **What happens:** Supabase auth calls (`/auth/v1/token`, `/auth/v1/user`) stayed pending indefinitely (multi-tab lock / stuck refresh); `initializeAuth` awaited `getSession()` with no timeout → blank page + spinner, every tab.
- **Still to look at:** root cause of the pending auth requests (supabase-js lock). Consider upgrading supabase-js and configuring a lock timeout.

## BUG-015 — Email cards show a "Mark as handled" tick that always errors
- **Severity:** P2 (UX)
- **Status:** verified (2026-09-03, code audit) — ✓ hidden on email touches in `OutreachCard.tsx` (server correctly rejects `mark_sent` for email; Skip remains in the clock menu). Verified in place (commit f7f3b15).

---

## Deferred — do not fix without a plan

## BUG-005 — 72h/7d email purge widened to 30 days (deliberate)
- **Severity:** P0 on paper (public promise mismatch) — **deferred by Shai**
- **Status:** deferred
- **Why deferred:** The 72-hour purge erased the same snippet text the timeline displays and that replies are built from — wiping visible history and breaking email replies. Widened to 30 days as a workaround.
- **Do not** restore the 72h window as a "fix." The real fix needs a design that preserves timeline history and reply context (durable `ai_summary` written *before* purge, UI reading the summary). Also reconcile the public commitment wording. Cases IN-2/IN-3/CL-3 stay ⏸ until then.

## BUG-006 — 90-day call purge not implemented on staging
- **Severity:** P1 on paper — **deferred** (tied to BUG-005's redesign)
- **Status:** deferred
- **What's missing:** No purge logic or expiry column for call audio/transcripts on staging; the 90-day promise can't be verified there.

---

*Add new bugs above the Deferred section, newest first within severity. Template:*

```
## BUG-XXX — <plain-English title>
- **Severity:** P0|P1|P2|P3
- **Status:** open
- **Found:** <date>, <which run/scenario>
- **What happens:** <plain English, 2-3 sentences>
- **Repro:** <numbered steps or query>
- **Claude Code prompt:** "<self-contained fix instruction>"
```
