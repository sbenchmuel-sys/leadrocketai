# DrivePilot Staging Test Plan

**The single source of truth for what gets tested against staging.** The nightly QA agent executes this plan; every merged PR must append its scenarios here (see "Maintaining this plan" at the bottom). Bugs found go to [BUGS.md](BUGS.md).

Last full revision: 2026-06-11 (built from the QA kit's 36 core cases + a feature inventory of all 436 commits / 82 PRs since 2026-03-01).

## The three catastrophic risks

Every test session starts from these. Anything touching them is **Tier 1** and gets tested first and deepest:

1. **Wrong email/SMS goes to a real person** — or a replied/paused/opted-out/bounced lead gets messaged.
2. **One dealership sees or modifies another dealership's data.**
3. **A public promise silently breaks** — retention purges, encryption at rest, consent.

Tier 2 = broad breakage (sync, classification, cron, scoring). Tier 3 = cosmetic/contained.

## Test environment

- **Database:** Supabase project `drivepilot-staging` (`jhipmqdpjenojfhfjgzq`). Production is NOT reachable from QA sessions — by design.
- **Test dealerships:** "Test Dealership A" (rep: `repa@drivepilot-test.com`) and "Test Dealership B" (rep: `repb@drivepilot-test.com`). Passwords are reset by the QA agent at run time.
- **The six personas:** Replied Rita, On-holiday Omar, Unsubscribed Uma (A); Bounced Ben, Group-thread Gina, Eligible Ed (B). Only Ed should ever be eligible for automated sends.
- **Staging frontend:** deployed to Vercel at **https://drivepilot-staging.vercel.app** (project `drivepilot-staging`, prebuilt static deploy, Vercel Authentication disabled so it's publicly loadable), pointed at staging Supabase. For Google sign-in to redirect back, staging Supabase Auth **Site URL / Redirect URLs** must include this origin (`https://drivepilot-staging.vercel.app/**`).
- **Authenticating the unattended UI run:** use **email/password**, NEVER Google — the static Vercel deploy's OAuth broker 404s (`lovable.auth.signInWithOAuth` has no server). Test users (`drivepilot-staging`, auto-confirmed): repA `repa@drivepilot-test.com` (`9d7556fb-eecf-4720-ae78-972cd8e54248`), repB `repb@drivepilot-test.com` (`ccbaab3f-3f59-4110-b84e-162ac69fa41a`). The password lives in `.env.staging` as `TEST_USER_PASSWORD` (NOT in this repo) and in the sandbox secret store. Two ways in:
  - **Preferred — session inject (robust, headless-safe):** `node scripts/qa/staging-login.mjs --user a|b` mints a real session and prints a one-line snippet; navigate to the staging origin, eval the snippet in the page, and it reloads authenticated into `/app/queue`. `--json` emits `{storageKey, storageValue, access_token, …}` for programmatic harnesses. The helper hard-aborts unless `SUPABASE_URL` targets the staging ref. Output contains live tokens — never commit it.
  - **Fallback — drive the form:** go to `/auth` (Sign In tab is default), fill `#signin-email` + `#signin-password`, click the **Sign In** button; success lands on `/app/queue` (or `/onboarding` if onboarding isn't done). Do NOT touch "Continue with Google".
- **Running the suites:** `npm test` (unit, offline) · `npm run test:edge` (Deno) · `npm run test:isolation` (live staging RLS isolation — needs the gitignored `.env.staging` + `TEST_USER_A/B_EMAIL/ID` + `TEST_USER_PASSWORD`; `src/test/integration/setup.ts` hard-aborts unless `SUPABASE_URL` is the staging ref `jhipmqdpjenojfhfjgzq`). **QA gate:** anything touching RLS / workspace isolation / `is_workspace_member`/`is_workspace_admin` must pass `test:isolation` before merge — extend that harness, don't rebuild it; if `.env.staging` is absent, skip and say so (never point it at prod). **Harness gotchas (don't "fix" away):** act as a user via supabase-js's `accessToken` option (a global `Authorization` header gets clobbered); insert fixtures WITHOUT a chained `.select()` (return=representation re-checks the SELECT policy at insert time → 403 before the creator-membership trigger is visible); staging needs Supabase's baseline role grants restored after any `DROP SCHEMA public` (`GRANT USAGE ON SCHEMA public` + `GRANT ALL ON ALL TABLES/SEQUENCES/FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role`, plus matching `ALTER DEFAULT PRIVILEGES`) or every PostgREST call 403s with "permission denied for schema public".
- **Running the automated suites in the Cowork sandbox:** the mount carries a Windows `node_modules`, so vitest fails on Linux with a missing-native-binary error (rollup/esbuild/swc are platform-specific), and a fresh `npm install` can't finish inside the 45s/command cap. **Fix: `bash scripts/qa/sandbox-bootstrap.sh`** — it adds ONLY the matching Linux native packages (at the versions already resolved in the tree) alongside the Windows ones; idempotent + resumable, so a run killed by the time cap just re-runs to continue. After it, `npm test` and `npm run test:isolation` work. **tsc is NOT blocked** (pure JS, runs from the mount) — type-check with **`npx tsc -b --noEmit`** (the `-b` is load-bearing: the root tsconfig is a solution file, so plain `tsc --noEmit` checks nothing and passes vacuously). The Deno edge suite (`npm run test:edge`) needs the Deno binary — **`bash scripts/qa/sandbox-bootstrap.sh --deno`** installs it to `node_modules/.bin/deno` (best-effort; npm puts that dir on PATH, so `test:edge` finds it with no extra setup). Run `--deno` as a separate command from the bare run so the download doesn't push the native-deps step past the 45s cap. If Deno can't be installed (e.g. musl, no `unzip`/`python3`), the safety-critical Deno logic is mirrored by vitest specs (`bounceClassification`, `unsubscribeDetection`, `campaignKbScope`, …).
- **Staging schema + deployment:** the staging schema was loaded from `staging_schema_load.sql` (a prod schema dump — NOT migration replay, which can't rebuild from scratch). **Build trap:** `vite.config.ts` hardcodes the PROD Supabase as a fallback and overrides `.env*`, so a staging build MUST export the staging vars first or it silently ships prod. Build + redeploy: `set -a; . ./.env.staging; set +a && npx vite build --mode staging` → grep `dist/` for the staging ref (assert no prod ref) → `cp -r dist/. .vercel/output/static/` → `VERCEL_TOKEN=… vercel deploy --prebuilt --prod --yes`.
- **Edge functions (deployed — verified 2026-06-22):** all edge functions ARE deployed and ACTIVE on staging (79 functions incl. `message-cleanup`, `automation-executor`, `classify-inbound`, `campaign-touch-scheduler`, `outreach-unsubscribe`, all senders), and their secrets are wired (functions return 200, not 500, on the AI/DB-dependent paths). **Verify deployment via the Supabase MCP, NOT via `git` / the `supabase` CLI / filesystem mounts** (those are unreliable in the QA sandbox — broken `git` + a Windows-built `node_modules` caused a prior run to falsely report "0 edge functions deployed"). Use `list_edge_functions(project_id="jhipmqdpjenojfhfjgzq")` + `get_logs(service="edge-function")`. Treat retention-purge / live cold-send / unsubscribe-endpoint as **exercisable on staging** — only report them BLOCKED if the MCP call itself fails. Caveat: `dispatch-automation-executor` cron is **intentionally `active:false`** (Ed has full-auto consent → real sends if enabled), so the live auto-send path is exercised by manual invoke / review mode, never by the cron.
- **Known deliberate deviations (do NOT file as bugs):** email/call auto-deletion is widened to 30 days on purpose (the 72h purge erased timeline history / broke replies — see QA-FOLLOWUPS.md). Staging cron is mirrored from prod (12 jobs, verified 2026-06-22) with the automation-executor job deliberately disabled (see Edge functions bullet). The `campaign-collateral` storage bucket is intentionally `public=true` (public-by-link read; member-scoped write) — see OD-3; verified 2026-06-17.

## Rules for the QA agent

- Reads are free; every test **write must be rolled back** or confined to the two test dealerships.
- Never seed data into, or send from, any workspace other than Test Dealership A/B.
- A failing test produces a BUGS.md entry with repro steps; a flaky test is worse than no test — investigate or delete it.
- Every real bug found becomes a permanent scenario in this plan so it can never come back silently.

---

# Part 1 — Core safety suite (run every night, in this order)

### Email & Automation engine

The production email sender. Each case proves a load-bearing guardrail still fires.

- **AE-1** (Tier 1) — A customer who replied does not get the queued automated email.
  - How: Queue Eligible Ed + Replied Rita; have Rita reply; run automation.
  - Pass when: Rita gets nothing; Ed gets his email.
- **AE-2** (Tier 1) — An out-of-office auto-reply pauses automation.
  - How: Set Omar's inbox to OOO; sync; run automation.
  - Pass when: Omar paused until return date; no email.
- **AE-3** (Tier 1) — "Unsubscribe/stop" permanently stops automation for that lead.
  - How: Uma replies "please unsubscribe me"; run now and next cycle.
  - Pass when: Uma stopped now and forever.
- **AE-4** (Tier 1) — A bounced email is recognised, not treated as a reply.
  - How: Point Ben at an invalid address; send; let bounce return; sync.
  - Pass when: Bounce flagged; lead not marked engaged.
- **AE-5** (Tier 1) — The same step is never sent twice.
  - How: Run automation twice quickly for Eligible Ed.
  - Pass when: Exactly one email; second run skipped.
- **AE-6** (Tier 1) — Daily cap and minimum gap between emails respected.
  - How: Lower cap; queue several eligible leads.
  - Pass when: Sends stop at cap; min gap honoured.
- **AE-7** (Tier 1) — A multi-person thread hands off to manual mode.
  - How: Gina's last inbound has 2+ on To/Cc; run automation.
  - Pass when: Gina flips to manual; no auto-send.
- **AE-8** (Tier 1) — Email sent from the correct mailbox.
  - How: Run a send in each test workspace.
  - Pass when: From-address matches workspace mailbox; misconfig blocks send.
- **AE-9** (Tier 1) — Withdrawing consent mid-flight stops the send.
  - How: Queue Ed, then remove from automation just before run.
  - Pass when: In-flight send skipped.
- **AE-10** (Tier 1) — Closed/inactive leads are never emailed.
  - How: Mark a lead closed_won; run automation.
  - Pass when: No send; removed from queue.
- **AE-11** (Tier 1) — AI draft checked before sending (no placeholders/leaked reasoning).
  - How: Force a draft containing "[First Name]".
  - Pass when: Send blocked by validator.
- **AE-12** (Tier 1) — WhatsApp auto-sends only to opted-in leads when WA automation on.
  - How: Queue a WA step for a non-opted-in lead.
  - Pass when: Skipped with clear reason.
- **AE-13** (Tier 2) — A stuck send recovers cleanly without double-sending.
  - How: Simulate a stuck job past expiry; run automation.
  - Pass when: Job expires; no duplicate email.

### Inbound sync, AI classification & 72h delete

Bodies are summarised then deleted; inbound waits for a summary, hard cap 7 days.

- **IN-1** (Tier 2) — New inbound emails appear on the lead's timeline.
  - How: Send from test-lead inbox to connected mailbox; sync.
  - Pass when: Message on the right lead/thread.
- **IN-2** (Tier 1) — WhatsApp/SMS bodies deleted within 72 hours.
  - How: Insert a >72h test message; run cleanup.
  - Pass when: Body gone; metadata/summary remain.
- **IN-3** (Tier 1) — Inbound email body kept until summarised, never past 7 days.
  - How: Test rows: un-summarised at 72h, and one at 7 days.
  - Pass when: Un-summarised survives 72h; both purged by 7d cap.
- **IN-4** (Tier 2) — After body deleted, AI summary still drives the timeline.
  - How: Purge a test message, then open the lead.
  - Pass when: Timeline/context still readable.
- **IN-5** (Tier 1) — Cleanup job only triggerable by the system.
  - How: Call cleanup endpoint without credentials.
  - Pass when: Rejected.

### Meeting summaries

Calendar → transcript → AI recap on the timeline. Test on your test calendar.

- **MT-1** (Tier 2) — A meeting is detected and linked to the right lead.
  - How: Create event with a test-lead attendee; run calendar sync.
  - Pass when: Meeting on that lead; future-meeting flag set.
- **MT-2** (Tier 2) — A transcript is fetched once available.
  - How: Record a short test meeting; wait for poller.
  - Pass when: Transcript stored, status ready.
- **MT-3** (Tier 2) — The AI recap is accurate and lands on the timeline.
  - How: Let the analyzer run on the ready transcript.
  - Pass when: Recap appears; matches what was said.
- **MT-4** (Tier 1) — A lead with a future meeting is paused from cold automation.
  - How: Eligible lead with a future meeting; run automation.
  - Pass when: Cold automation holds off.
- **MT-5** (Tier 2) — Only the system can trigger the analyzer.
  - How: Call analyzer endpoint without credentials.
  - Pass when: Rejected.
- **MT-6** (Tier 3) — No-transcript / no-show handled gracefully.
  - How: Meeting with no transcript available.
  - Pass when: No crash; sensible empty state.

### Phone calls & 90-day delete

Twilio calls recorded, transcribed, analysed; audio+transcripts purge after 90 days.

- **CL-1** (Tier 2) — An outbound test call connects and is recorded.
  - How: Call your own test number.
  - Pass when: Connects; recording captured.
- **CL-2** (Tier 2) — The recording is transcribed and analysed.
  - How: Let the pipeline run after the call.
  - Pass when: Transcript + AI analysis on the lead.
- **CL-3** (Tier 1) — Call audio + transcripts deleted after 90 days.
  - How: Insert a >90d test call/transcript; run retention.
  - Pass when: Audio+transcript removed; metadata kept.
- **CL-4** (Tier 2) — An inbound test call is routed correctly.
  - How: Call the workspace number from a test phone.
  - Pass when: Routed/logged to the right workspace.

### Dealership data isolation

The no-leak promise. Needs two test workspaces.

- **IS-1** (Tier 1) — Dealership A cannot see Dealership B's leads.
  - How: Log in as A; try to view B's leads (UI + query).
  - Pass when: Zero of B's rows returned.
- **IS-2** (Tier 1) — Dealership A cannot modify/delete Dealership B's data.
  - How: As A, attempt update/delete on B's rows.
  - Pass when: Zero rows affected.
- **IS-3** (Tier 1) — Conversations, timelines, drafts, calls all workspace-scoped.
  - How: Repeat IS-1 across each data type.
  - Pass when: No cross-workspace bleed.
- **IS-4** (Tier 1) — Bulk lead actions stay inside one workspace.
  - How: Run a bulk action as A; check B.
  - Pass when: B untouched.
- **IS-5** (Tier 2) — Switching workspaces fully swaps the data shown.
  - How: User in both A and B switches between them.
  - Pass when: No stale data lingers.

### Tokens & encryption-at-rest

Mail/OAuth tokens must be encrypted; invisible from the UI so needs explicit checks.

- **EN-1** (Tier 1) — Newly stored tokens are encrypted, never plain text.
  - How: Connect a test mailbox; inspect stored token.
  - Pass when: Stored value is ciphertext.
- **EN-2** (Tier 1) — Tokens decrypt and work for sending/syncing.
  - How: Run a send/sync using the token.
  - Pass when: Works — round-trips correctly.
- **EN-3** (Tier 2) — Disconnecting a mailbox removes its credentials.
  - How: Disconnect a test mailbox.
  - Pass when: Token no longer present/usable.

### Outreach wizard guardrails (flyer ingest + LinkedIn manual)

Covers the New-outreach wizard's two newest promises — flyer→knowledge ingest (PR #93) and LinkedIn as a cadence channel (PR #94). All Tier 1: they touch automated sends, retention, and isolation.

- **OW-LI-G1** (Tier 1) — LinkedIn touches never auto-send.
  - How: As Dealership A, create an outreach with LinkedIn selected; enroll one lead; let a LinkedIn touch fall due; run the executor in supervised/review mode.
  - Pass when: the automatic sender picks up only the email touches; it never sends, claims (`cold_touch_<id>`), or marks-sent any LinkedIn touch — the LinkedIn touch stays a manual Queue task. Zero automated activity on any LinkedIn touch.
- **OW-FLY-G1** (Tier 1, retention) — A flyer can't smuggle customer text past retention.
  - How: Audit every path that can reach `ingestCampaignKnowledge` from the wizard. Confirm the only input is a file the rep attaches (→ `process-knowledge-document`, `source = campaign:<id>`, `allowed_customer_facing:true`); no customer email/message body is ever fed in.
  - Pass when: only rep-attached collateral lands in `kb_chunks` under `source = campaign:<id>`; re-uploading REPLACES the prior chunks (stable source) rather than piling up; no customer-body path exists. (Wizard-specific instance of KB-4 / OD-2 — `kb_chunks` persists indefinitely, so a customer-body leak here would dodge the 72h/7-day purge.)
- **OW-LI-G2** (Tier 1, isolation) — Wizard output is workspace-isolated.
  - How: Create the outreach (LinkedIn selected + a flyer attached) as Dealership A; sign in as Dealership B (`repb@drivepilot-test.com`).
  - Pass when: B sees none of A's outreach, its LinkedIn touches, or any flyer / `kb_chunks` content. Fully isolated.


---

# Part 2 — Feature coverage (everything shipped since March 2026)


Generated 2026-06-11 from `git log --first-parent main --since=2026-03-01` (436 commits, PRs #1–#82 plus direct Lovable pushes), PROGRESS.md, EDGE_CASES.md, KNOWN_ISSUES.md, QA-FOLLOWUPS.md, and BULK_OPS_INVENTORY.md.

**Tier 1** = touches live email/SMS sends, cross-workspace isolation, or data retention. Test these first and deepest.

---

## March 2026 — foundation (mostly Lovable direct-to-main)

### Twilio voice calling (browser click-to-call + webhooks)
- What it does: Reps place outbound calls from the browser via Twilio (TwiML, dynamic callerId from settings) and receive inbound calls; webhook signatures validated.
- Where: Lead detail / queue Call buttons; `twilio-voice-webhook`, `twilio-token` edge functions.
- PRs/commits: `4df1995`, `6b686e5`, `7f2aaf3`, `59eaa98`, `a14657c`, `7873621`, `96fb34f` (2026-03-01); `39a65b1`, `05800f1` (03-12); `e318f94`, `e223a911`/`e223944` voice audit (04-13); hardening in PR #67.
- Existing tests: none
- Scenarios:
  - VOICE-1: Rep clicks Call on a lead with a valid phone → Twilio token fetched, call connects, callerId matches the workspace's configured Twilio number.
  - VOICE-2: Inbound call hits `twilio-voice-webhook` with an invalid Twilio signature → rejected, no call session row created.
  - VOICE-3: Call errors mid-dial → call state resets (no stuck "in call" UI, `05800f1`).
  - VOICE-4 (Tier 1, isolation): callerId can never resolve to another workspace's Twilio number.

### Call transcripts & summaries (ASR pipeline) — Tier 1 (retention)
- What it does: Records calls, transcribes via Google Speech ASR, generates an expanded call summary, writes to lead timeline; audio + transcripts auto-purge after 90 days (public commitment).
- Where: Lead timeline / call summary view; `call-ingest-recording`, `call-transcribe` edge functions.
- PRs/commits: `9c56ef1`, `2565ed4` (Switch to Google Speech, 04-13), `7d07311`, `d9246fb`, `b5c9cb5` (04-14), `da95f9b` hardened transcript fetch (05-26), PR #45 (voice interactions write), PR #67 hardening.
- Existing tests: none
- Scenarios:
  - CALL-1: Completed call with recording → transcript appears, summary generated, timeline row created on the right lead.
  - CALL-2: ASR provider failure → call row survives without transcript, no crash, retry possible.
  - CALL-3 (Tier 1, retention): call audio/transcript rows older than 90 days are purged; verify the retention job still fires.
  - CALL-4: Voice call writes an interaction so `deriveAction` can react (KNOWN_ISSUES notes this was a no-op until PR #45).

### Unified inbox + multi-channel composer + dashboard queue v1
- What it does: One inbox across email/WhatsApp/SMS channels with channel mappings, unified intelligence card, action router, Inbox Evidence Panel + Lead Context Panel, and a dashboard queue view.
- Where: `/app/inbox`, dashboard queue view.
- PRs/commits: `4c21ac9`, `bb132c1`, `6494e37`, `8d5acb8`, `254cb71`, `aac1da1`, `ff8f743`, `4c8c6c1`, `021ae4e`, `ded025d` (all 2026-03-02), `5fdb031` inbox state cache, `de8d7ce` feature flags.
- Existing tests: none
- Scenarios:
  - INBOX-1: Inbound WhatsApp from a known number → mapped to the right lead, appears in unified inbox and lead timeline.
  - INBOX-2: Composer switched between channels → draft content and channel constraints follow (no email body sent as SMS).
  - INBOX-3: Send from composer → UI doesn't desync (optimistic update matches server, `3c08d80`).
  - INBOX-4 (Tier 1, isolation): inbox only ever lists conversations from the user's workspace.

### Lead enrichment (pluggable providers + signals)
- What it does: Enriches leads from external providers (pluggable), stores results in an enrichment table with RLS, surfaces richer "Signals" summaries on the lead.
- Where: Lead detail Signals UI; background enrichment fetch.
- PRs/commits: `c184b63`, `fce2ca2`, `2a1ef27`, `f2aed45`, `bf822ac` (03-02), `4b1526a` delete policies (03-24), `157bb1b` (03-25).
- Existing tests: none
- Scenarios:
  - ENR-1: New lead with company email → enrichment runs, Signals panel shows provider data.
  - ENR-2: Provider returns nothing/errors → lead usable, no blocking spinner.
  - ENR-3 (Tier 1, isolation): enrichment rows are workspace-scoped; delete policies allow cleanup only within workspace.

### Action-required detection: snooze/dismiss + meeting-confirmation + staleness guards
- What it does: Detects meeting confirmations and defer signals on inbound email, adds temporal awareness so stale post-meeting recaps don't fire, and lets reps snooze/dismiss the action.
- Where: Dashboard ActionRequiredPanel / lead header; sync-time detectors.
- PRs/commits: `181a5d9` meeting confirmation detector, `eeed233` temporal/staleness guards, `bf69ce4` defer signals, `b9b2ef2`/`12ab072` snooze dismiss, `a04ff3b` stale recap guard (all 03-02), `9865144`.
- Existing tests: none (EDGE_CASES.md documents 14 analyzed edge cases)
- Scenarios:
  - ACT-1: Inbound "see you Tuesday" → meeting-confirmation detected, action updates accordingly.
  - ACT-2: OOO and meeting confirmation in the same email → precedence handled (EDGE_CASES #1 — stale `hasFutureMeeting` was a real bug).
  - ACT-3: Snoozed action → stays hidden until snooze expiry; fresh inbound during snooze re-arms (EDGE_CASES #8 ordering).
  - ACT-4: Calendar accept that also contains a substantive question → not auto-cleared (EDGE_CASES #4, body never inspected — known gap).

### Nurture auto-send + long-cycle nurture — Tier 1 (email send)
- What it does: Automated nurture email sequences with auto-send, "Send Now" for past-due drafts, "Switch to Auto" per lead, staggered scheduling, and a long-cycle nurture track (PR 3.2).
- Where: Lead detail automation controls; `automation-executor` (background).
- PRs/commits: `6e052ce`, `ea7b357`, `272bd3d` (03-05), `fca0354`/`e378deb`/`a9baf02` scheduling hardening (04-05), PR #13 (`7605704`, long-cycle nurture), `52c0478` re_engagement check.
- Existing tests: none
- Scenarios:
  - NUR-1 (Tier 1): Lead in nurture with `automation_mode` set → next step sends inside the workspace send window only.
  - NUR-2 (Tier 1): Lead replies mid-sequence → automation instantly pauses (load-bearing guardrail in `automation-executor`).
  - NUR-3: "Send Now" on a past-due email → sends once, no duplicate when the cron also fires (claim dedup).
  - NUR-4 (Tier 1): Lead without consent (`automation_mode IS NULL`) → never scheduled, never sent.
  - NUR-5: Nurture sends are staggered, not all at the same minute.

### Campaign settings + daily send cap — Tier 1 (email send)
- What it does: Per-workspace campaign settings UI and a daily cap on automated sends.
- Where: Settings; `automation-executor` (background).
- PRs/commits: `a180ee0` (03-09), `9749774` daily send cap (03-10), `2a355c6` dashboard query limit.
- Existing tests: none
- Scenarios:
  - CAP-1 (Tier 1): With cap = N, the executor stops at N sends/day and resumes next day; capped leads get deferred, not dropped.
  - CAP-2: Settings change takes effect on the next executor run without redeploy.

### Knowledge Base retrieval & grounding stack
- What it does: Task-aware semantic KB retrieval (`match_knowledge_chunks_v2`), enhanced chunking, lead context cache, lead_signals, message_generation_log, learned interactions, channel framework router, sequence-aware messaging; later "last-mile" upgrade (stage policy layer, reply objective orchestrator, ReplyQualityEvaluator, deal memory layer, continuity scoring); Card & Playbook KB types.
- Where: `ai_task` edge function + `_shared/` (background, feeds all drafting).
- PRs/commits: `9e4be38`, `dc0ff8f`, `387c8d2`, `cb5afe9`, `e1cd893`, `8c59080`, `b2214b8`, `949b854`, `c08789f`, `befc9c6`, `f1fd387`, `58345ea` (03-10); `aa9023a`→`a469cd5` last-mile cluster (03-29); `9cd1587` Card & Playbook types; `0ac0224` chunk-limit relax.
- Existing tests: none (campaign-scoped KB tests exist, see Outreach KB section)
- Scenarios:
  - KB-1: Draft generation for a lead pulls KB chunks relevant to the task type (intro vs reply vs nurture), and the draft references real KB facts.
  - KB-2: v1/unnumbered RPC signatures are never called (only `match_knowledge_chunks_v2` — CLAUDE.md guardrail).
  - KB-3: Empty/failed AI response → graceful fallback, no blank email queued (`7f4e00b`).
  - KB-4 (Tier 1, retention): customer message bodies are never ingested into `kb_chunks` (which persists forever) — the purge must not be bypassed.
  - KB-5: Deal memory updates after key events and is reflected in subsequent drafts (continuity scoring).

### AI email drafting quality pipeline (scorer, reasoning-strip, corrections)
- What it does: Scores draft quality, strips leaked internal reasoning from outbound emails, validates greetings/sign-offs, stores rep corrections (`lead_ai_corrections`) with admin tuning flags, and shows automation draft previews.
- Where: Email composer + `ai_task` / `automation-executor` (background).
- PRs/commits: `8815af2` quality scorer (03-12), `c695000`/`359c7d0` strip leaked reasoning (03-22/23), `1e653ac` lead_ai_corrections, `ca32571` admin tuning flag UI, `9ff3e5f` draft previews (03-23), `a91acbb`/`16544cd` blank emails + HTML format (04-29), `72a88f0`/`653201d` greeting validation (05-24), `0a196bb` loosened sign-off validation (06-09), `2fd14c4` draft cleansing.
- Existing tests: none
- Scenarios:
  - DRAFT-1 (Tier 1): No generated email ever contains leaked chain-of-thought/reasoning text ("Best Next Step", bracketed planning, etc.) — check auto-send path especially (`9b75506` fixed a reasoning leak in auto).
  - DRAFT-2: Generated email renders proper HTML paragraphs in Gmail and Outlook clients (not collapsed plain text).
  - DRAFT-3: Draft with missing greeting / double sign-off → auto-patched or regenerated, never sent malformed.
  - DRAFT-4: Rep edits a draft → correction captured in `lead_ai_corrections` and respected on regenerate.

### Multi-tenant auth hardening + unified timeline ledger — Tier 1 (isolation)
- What it does: Hardened workspace RLS (`is_workspace_member()` / `is_workspace_admin()`), backfilled workspace linkage on leads, and consolidated all comms into the canonical `lead_timeline_items` ledger (replacing `interactions`).
- Where: Database-wide (background); lead timeline UI.
- PRs/commits: `989993d`/`ac6d870`/`4068877` auth hardening, `dbabab1`, `3dfc472`, `21f91a2`, `d74dedd`, `418b1fe`/`5e99884` canonical intelligence layer, `b2e4235` (all 03-24); timeline-first writes `bd6fcd3`→`3e77ad4` (04-21/23).
- Existing tests: `src/test/integration/rlsIsolation.test.ts` (committed; run via `npm run test:isolation`; IS-1..IS-5 PASS on staging 2026-06-11)
- Scenarios:
  - ISO-1 (Tier 1): User in workspace A cannot read or update any lead/timeline/message row of workspace B (UPDATE affects 0 rows).
  - ISO-2 (Tier 1): All new comms write to `lead_timeline_items` only — no new writes to legacy `interactions` (CLAUDE.md mid-migration guardrail).
  - ISO-3: Dual-read fallback still renders pre-migration history correctly.
  - ISO-4 (Tier 1): SECURITY DEFINER RPCs (`set_timeline_followup_state`, group RPCs) authorize via `is_workspace_member()` and reject non-members.
  - ISO-5 (BUG-010 regression): the two `automation-executor` system notes — OOO-return and unsubscribe-stop — must write through `createCanonicalInteraction` so they ALSO project into `lead_timeline_items` (not a bare `.insert()` into `interactions`). Pass when: grep of `automation-executor/index.ts` shows both system-note sites call `createCanonicalInteraction`, `workspace_id` is selected in the OOO and candidate queries so the projection fires, and the only remaining `from("interactions")` references are `.select()` reads. Guards against the note vanishing when legacy `interactions` is retired.

### Cron-dispatcher + webhook auth lockdown + send-claim dedup — Tier 1 (send)
- What it does: Single entry point for scheduled jobs (`cron-dispatcher` with ALLOWED_TARGETS), hardened internal/webhook auth, and a pre-send claim index + claim lifecycle so the executor can never double-send; interaction dedup.
- Where: Background (all crons).
- PRs/commits: `4338e1f`, `7769dca`, `25503ab`, `6979700`, `6da53bf`, `038a092`, `c7bf159`, `6c522e7`/`d17f8c2` canonicalInteraction, `5a92b74` (all 03-26), `e222911` dispatcher auth fix (04-12), `8eaa2b7` automation cron auth guard.
- Existing tests: none
- Scenarios:
  - CRON-1: A target NOT in `ALLOWED_TARGETS` invoked through cron-dispatcher → rejected.
  - CRON-2 (Tier 1): Two overlapping executor runs against the same eligible lead → exactly one send (claim wins, loser skips).
  - CRON-3: Stale/orphaned claims expire and don't permanently block a lead's sends.
  - CRON-4: Unauthenticated direct calls to internal edge functions are rejected.
  - CRON-5 (regression for gmail-bulk-sync dual-mode auth fix, 2026-06-22): Invoke cron-dispatcher with `{"target":"gmail-bulk-sync"}` → returns **200** (not the old gateway `UNAUTHORIZED_NO_AUTH_HEADER` 401) and the JSON body reports `mode:"scheduled"` with `connectionsProcessed`/`leadsProcessed` counts. Confirms the scheduled path actually runs now that the function has an in-code internal-secret gate + `verify_jwt=false`.
  - CRON-6 (Tier 1, isolation): With a connected Gmail on Dealership A and another on Dealership B, run the scheduled `gmail-bulk-sync`. Every interaction/lead update it writes must stay inside the connection owner's own workspace — A's mailbox must NEVER import email onto a B lead, and vice-versa. (The cron branch fetches leads with an explicit `workspace_id` filter resolved from each connection owner's membership.)
  - CRON-7 (Tier 1, send-safety): After the scheduled sync derives actions, no lead gets a future `eligible_at` + `needs_action` + outbound `next_action_key` (the consent gate must strip it). The scheduled sync imports email and surfaces queue actions only — it must never cause `automation-executor` to send.
  - CRON-8: The user "Sync now" / per-lead sync (user JWT) still works after `verify_jwt=false` — a valid user token syncs that rep's leads; a request with no/invalid token is rejected 401 and CANNOT trigger the workspace-wide scheduled self-sync (that branch requires the internal secret or service-role key).
  - CRON-9 (coverage, scheduled sweep): With a rep owning more leads than fit in one run budget, the scheduled `gmail-bulk-sync` must eventually sync ALL of them across successive runs (no permanent tail-skip). Verify `gmail_connections.bulk_sync_cursor` advances by the number processed each run and wraps to 0 after a full pass; leads are scoped to `owner_user_id` (rep A's run never touches rep B's leads).

### Structured campaigns & cadence resolver (pre-Outreach)
- What it does: Unified campaign storage + structured campaign types and a step resolver shared between manual drafting and the executor; dynamic cadence wired to the executor.
- Where: Background + manual draft path; `campaignResolver.ts` (TWO copies: `src/lib/` and `supabase/functions/_shared/`).
- PRs/commits: `f93ee48`, `33db68d`, `30d159e`, `7e4291b`, `8f8d685` (03-26), `9d7be1a` stagger outbound (03-16), `767c760` lead segmentation.
- Existing tests: `src/lib/__tests__/campaignResolver.golden.test.ts` (added later by Unit B, locks steps 1–4 byte-identical)
- Scenarios:
  - CAD-1 (Tier 1): `send_pre_1..4` / `nurture_1..4` action keys resolve byte-identical to the golden snapshots (live send path).
  - CAD-2: Client and server resolver copies produce identical output for the same input (known divergence hazard).
  - CAD-3: Manual draft for a campaign lead uses the same resolved instruction the executor would.

---

## April 2026 — channels, import, Outlook, candidates, safety

### SMS channel (draft, send, inbound + status webhooks) — Tier 1 (SMS send)
- What it does: SMS as a first-class channel — AI SMS drafting with SMS-specific prompts, send button, draft save, inbound SMS webhook with signature check, delivery status webhook.
- Where: Composer / lead detail; `sms-send`, `twilio-sms-webhook` edge functions.
- PRs/commits: `ead59e8`→`644c949`→`93dd423`→`5d954ae`→`72237c7`→`77ff049`→`a830616` (04-12), `9ff5101` inbound webhook, `5e92d42` signature fix (04-13), `4490c4f` status webhook (05-20), `b1cd99f` capture fix (04-16).
- Existing tests: none
- Scenarios:
  - SMS-1 (Tier 1): Rep sends an SMS → delivered via Twilio, timeline row created, `messages.body_ciphertext` set with `expires_at` (+72h purge — retention commitment).
  - SMS-2: Inbound SMS → matched to lead, appears in inbox/timeline; invalid Twilio signature rejected.
  - SMS-3: SMS draft contains no reasoning leak and respects SMS length constraints (`77ff049`).
  - SMS-4: Status webhook updates delivery state; failed delivery is visible, not silent.

### LinkedIn manual channel
- What it does: LinkedIn as a manual outreach channel — prepares a message, copies to clipboard, opens the profile (LinkedIn blocks prefill); preview fallback.
- Where: Composer / Outreach queue card.
- PRs/commits: `1bd4b46`, `d0e9b14`, `9f03287`, `7333b49` (04-13).
- Existing tests: none
- Scenarios:
  - LI-1: Lead with `linkedin_url` → "Open LinkedIn" copies the prepared message and opens the profile.
  - LI-2: Lead without `linkedin_url` → control hidden/disabled, no dead button.

### Lead import (CSV / Excel onboarding)
- What it does: Bulk lead import with column mapping, Excel date handling, dedup, notes alias matching.
- Where: Onboarding flow + `LeadImportDialog`.
- PRs/commits: `04974ed` (04-14), `709cffb` Excel date serialization, `c587d9b`/`d588096` column mapping + notes alias (04-16), `fffe00e` Excel parsing & dedup (04-30), `9ebf3df`/`6a20ff7` date/timezone fixes.
- Existing tests: `src/lib/emailValidation.test.ts` (validation added by Outreach Unit C-4)
- Scenarios:
  - IMP-1: Import an .xlsx with date columns → dates land correctly (no serial-number or off-by-one-day artifacts).
  - IMP-2: Re-importing the same file → duplicates are not created.
  - IMP-3: File with invalid/role/throwaway emails → flagged in the heads-up; invalid rows can't be enrolled in outreach (fail-closed).
  - IMP-4 (Tier 1, isolation): imported leads land only in the importing user's workspace.

### Style profile system (per-rep voice)
- What it does: Captures the rep's writing style on every send, builds a style profile used by drafting; thumbs-up/down feedback UI in the composer; batch email generation queue.
- Where: Email composer (background capture).
- PRs/commits: `a243126`, `86e0db4`, `8f351b3`, `0abfbba` (04-16), `dd0bb36` multi-channel plan.
- Existing tests: none
- Scenarios:
  - STY-1: After several manual sends, generated drafts measurably reflect the rep's style profile.
  - STY-2: Feedback (thumbs) recorded and queryable; doesn't block send on failure.
  - STY-3: Batch generation queue processes without starving interactive drafting.

### Outlook mail integration
- What it does: Full Outlook/Microsoft 365 support — OAuth (popup + callback + race fixes), sync + bulk sync, Sent Items capture, tenant_id on `mail_accounts`, webhook JWT check, refetch with ConsistencyLevel header.
- Where: Settings → connections; `outlook-sync`, `outlook-send` edge functions.
- PRs/commits: `08206d0`, `722a7f9`, `49babe8`, `87fd4cf`, `3d00a39` (04-23..), `36ea9e3`/`97cb934` sync + bulk sync (04-28), `63bb417` reply logic, PR #34 hardening + `153582b` tenant_id (05-18), `f90baf4` webhook JWT (04-30), PR #55 refetch consistency (05-27), `055aba5` sentItems filter.
- Existing tests: none
- Scenarios:
  - OUT-1: Connect Outlook → OAuth completes (no popup race), initial sync pulls inbox + sent items.
  - OUT-2: Send via Outlook → `provider_message_id` captured from Sent Items lookup; on miss, graceful degradation + `mail.outlook.sent_items_capture_missed` log (known gap).
  - OUT-3: Outlook webhook with bad JWT → rejected.
  - OUT-4 (Tier 1, isolation): `mail_accounts.tenant_id` keeps multi-tenant MS orgs separated; tokens encrypted at rest (QA-FOLLOWUPS flags `mail_accounts` token encryption as UNVERIFIED — check explicitly).

### Gmail connection improvements
- What it does: Gmail account selection prompt on connect, default-account bug fix, simplified inbox connection flow, read-headers fix, backfill fallback.
- Where: Settings → connections; `gmail-sync`.
- PRs/commits: PR #25 (`c0cb4ee`), `4a8ae7b`, `87fd4cf` (04-28), `1b3632d` read headers (04-29), `7b7bf82` backfill fallback (06-01).
- Existing tests: none
- Scenarios:
  - GM-1: User with multiple Google accounts → account picker shown, chosen account connected (not the browser default).
  - GM-2: Reconnect after token expiry → sync resumes without duplicate timeline rows.

### Lead Candidates pipeline ("Pending leads")
- What it does: Detects probable leads from synced email (`detect-lead-candidates` cron), AI-scores them advisory-only (`score-lead-candidate`), seeds from a lookback window on new connects, Pending tab with Approve/Dismiss/Merge + bulk actions + dismiss-lists, settings card, per-workspace personal-domain toggle.
- Where: `/app/leads` Pending tab; Settings → Lead Detection; background crons.
- PRs/commits: PRs #4–#8, #10 (`6b269df`, `3749094`, `53d71e2`, `748d180`, `bb2dded`, `0ee9974`, `4aa4b5f`, 04-29); `a71606f`/`dccc94b` allow_personal_domains, `6aaaaa5` duplicate prevention, PR #28 onconflict case-insensitive, `7c09546` restricted updates, PR #76 display name fix (06-10).
- Existing tests: none
- Scenarios:
  - LC-1: Fresh inbound from an unknown business domain → candidate appears in Pending with a score; approving creates a lead and future emails attach to it.
  - LC-2: Same email address arriving again, or an already-approved email → no duplicate candidate (case-insensitive).
  - LC-3: Dismiss domain forever → that domain never resurfaces; dismiss-list editable in Settings.
  - LC-4: Personal-domain toggle off → gmail.com senders not proposed; on → they are.
  - LC-5: New mailbox connect → lookback seed scans only the configured window, once (existing accounts backfilled as seeded).
  - LC-6: Candidate with no display name → sensible name derived (PR #76).

### Email-send safety floor (consent gate, timezone window, Unit 0) — Tier 1 (send)
- What it does: After the 2026-04-30 5am-sends incident — consent gate (`automation_mode` required), timezone-aware send window (fail-closed when workspace TZ unset), workspace timezone settings card, new-campaign-lead 24h cooldown, and a volume tripwire (>50 sends/15min logs `volume_alert` per mailbox AND per workspace).
- Where: `automation-executor` + `syncEngine` (background); Settings → Workspace.
- PRs/commits: `6b2e893`, `c4e818a`, `4f631a0`, `f5d20c4`, `c36cae0` (04-30), `e5c99fa`, `ac609d2`, `26ec840` shared OOO helper (05-03), PR #62 Unit 0 (`9ee3c88`, 06-06), `5fad773` paused all automation leads.
- Existing tests: none
- Scenarios:
  - SAFE-1 (Tier 1): Workspace with NULL timezone → zero auto-sends (fail-closed) and the Settings card shows "automation paused".
  - SAFE-2 (Tier 1): Lead created <24h ago with a `campaign_id` → deferred to created_at+24h snapped into the window, `skipped` row logged. Non-campaign nurture leads are NOT cooldown-gated (documented intent — verify it still sends for consented inbound leads).
  - SAFE-3 (Tier 1): Sends only inside the workspace-TZ send window — re-test around DST boundaries.
  - SAFE-4: Blast of >threshold sends in 15 min across two mailboxes in one workspace → workspace-level `volume_alert` fires; tripwire never throws/aborts the run.
  - SAFE-5 (Tier 1): OOO inbound detected → automation pauses (shared OOO helper used by all paths).

### Multi-recipient email + manual mode (Deals PR 1.x) — Tier 1 (send)
- What it does: Captures full participants (to/cc) on every interaction, Cc field + reply-all toggle in composer, multi-recipient send, manual-mode badge, automation auto-pause when the rep takes over.
- Where: Email composer / lead detail; `gmail-send`/`outlook-send`.
- PRs/commits: `02b90ca` (PR 1.1), `8675202`/`ccbfb55` (PR 1.2), `4c7aab5` manual mode SQL, `ae44e8e` CC auto-fill fix, `0e5639a` automation consent dialogs (04-29/30).
- Existing tests: none
- Scenarios:
  - MR-1 (Tier 1): Reply-all on a multi-recipient thread → all original recipients in To/Cc, none duplicated, none dropped.
  - MR-2: Manual send on an automated lead → automation pauses, manual-mode badge appears.
  - MR-3: `to_emails`/`cc_emails` written to `metadata_json` on every outbound (rows before 2026-04-30 are empty — fail-closed caveat for Reply logic).

---

## May 2026 — deals, meetings, retention, intent, action queue 2a

### Stakeholders & Partners + Contact detail page
- What it does: Multiple leads per deal grouped via `lead_groups` (champion-anchored), third-party partners via `group_partners`→`contacts`; sidebar panel with add/swap/remove; contact detail page at `/app/contacts/:id` with cross-deal view and RLS-aware editing.
- Where: Lead detail sidebar; `/app/contacts/:id`.
- PRs/commits: PR 2.1 (`7f5f461`), PR 2.2 (`8f98ee6`) 05-03; PR 2.3 / #11 (`77c8c60`) contact detail.
- Existing tests: none
- Scenarios:
  - STK-1: Add stakeholder to a deal → group created with champion; removing the last member auto-cleans the empty group (trigger).
  - STK-2: Champion swap → group timeline and Reply targeting still resolve correctly.
  - STK-3: Non-admin, non-assigned rep opens contact detail → fields render disabled with tooltip (RLS-aware UI).
  - STK-4 (Tier 1, isolation): group RPCs (`create_lead_group_with_champion`, `set_lead_group_champion`) reject cross-workspace lead ids.

### Timeline Reply / Follow-up buttons + snooze state — Tier 1 (send-adjacent)
- What it does: Per-row Reply on the latest unanswered `email_inbound` (thread-scoped clearing via `to_emails`, To-only), per-lead "always" Follow-up on the most recent >5-day-old outbound, shared Snooze 3/5/7 / Dismiss popover backed by `timeline_followup_state` (sole write path: `set_timeline_followup_state` RPC), subtle ring on fresh inbound, `extractBareEmail` helper, app-wide permanent dismiss (`leads.action_permanently_dismissed`).
- Where: Lead detail timeline (`TimelineTab.tsx`).
- PRs/commits: PR #8 (PR 2.4, `15ecd30`), PR #9 bugfixes (`9a76176` + `e6dc395` vitest edge-case tests), PR #36 followup normalize rows (`81a9aee`).
- Existing tests: `e6dc395` added vitest edge-case tests (timeline rules); check `src/lib`/`components` for the spec files in the current tree.
- Scenarios:
  - TL-1: Inbound, then outbound reply with sender in To → Reply button clears; sender only in Cc → button stays (Cc does NOT clear).
  - TL-2: RFC-2822 wrapped addresses ("Name <a@b.com>") compared correctly via `extractBareEmail` in both directions.
  - TL-3: Outbound >5 days old, no later inbound → exactly ONE always-visible Follow-up per lead; older outbounds reachable on hover.
  - TL-4: Snooze 3 days then Dismiss with 5s undo → state persists via RPC; transient auth error retried once (400ms), other errors throw.
  - TL-5: Pre-2026-04-30 outbound rows (empty `to_emails`) → Reply fails closed (button stays visible) — expected, not a bug.
  - TL-6: Bounce / OOO / unsubscribed sender → Reply suppressed.

### Meeting recaps & transcripts (Teams / Meet)
- What it does: Meeting schema + workspace enforcement, Teams/Meet transcript fetch, structured meeting recap, post-meeting analyzer (phase 3), follow-up email field, dispatch fixes.
- Where: Lead detail Meetings tab; background transcript fetchers.
- PRs/commits: PR #22 (`af07eeb`), PR #23 enforce workspace (`a9ff820`), `c36804e`, `d0dc2a5`, PR #29 Teams transcript (`73ff8fb`), PR #30 meeting analyzer (`1685140`), `1d4f4dc` structured recap, `8748613` followup email field, PR #32 Teams dispatch fix, PR #35 meet transcript correctness, `d860f30` meeting link gating.
- Existing tests: none
- Scenarios:
  - MTG-1: Completed Teams meeting with transcript → recap generated, attached to the right lead's Meetings tab.
  - MTG-2 (Tier 1, isolation): meeting rows are workspace-enforced; a meeting can't attach to another workspace's lead.
  - MTG-3: Transcript unavailable/late → no recap from partial data; retry path works (`da95f9b`).
  - MTG-4: Stale post-meeting recap doesn't fire for a meeting confirmed long ago (staleness guard).

### Calendar events sync + OAuth scope reduction
- What it does: Calendar events table + sync; dropped `drive.readonly` and `onlineMeetings` scopes (least privilege); error modal close fix.
- Where: Calendar surfaces / lead meetings; background sync.
- PRs/commits: PR #16 (`4ef9ad9` + `20bbf18` migration), PR #17 drop-drive-readonly, PR #18 drop-online-meetings, `0030a0b`.
- Existing tests: none
- Scenarios:
  - CALSYNC-1: Connected calendar → events sync and meeting detection uses them (`hasFutureMeeting`).
  - CALSYNC-2: Re-consent after scope reduction → connection works without the dropped scopes.

### Message-body retention & ai_summary fallback — Tier 1 (retention)
- What it does: 72h purge of raw message bodies (SMS/WhatsApp unconditional; inbound email gated on classifier `intent IS NOT NULL` with 7-day hard cap), `classify-inbound` writes durable paraphrased `ai_summary` before purge, context builders fall back to `ai_summary`, backfill of inbound summaries, rich pilot email summaries.
- Where: `message-cleanup` hourly cron + `expire_old_messages()` SQL fallback (background); timeline rendering (`SummaryBody`).
- PRs/commits: PR #37 email 72h purge (`976e63c` + `fae774f` applied), PR #49 ai-summary write-and-fallback (`487a606`, `910cd2a`, `cf99ec6` backfill, `c550353` extended retention & summary), PR #52 rich summaries (`75df6f1`), PR #53 backfill loop (`339c192`), `dcbd215` drain + disabled purge (06-01), `a06b350` inbound mirroring.
- Existing tests: none
- Scenarios:
  - RET-1 (Tier 1): Outbound email body purges at 72h; inbound waits for `intent IS NOT NULL` OR 7-day hard cap — verify both branches.
  - RET-2 (Tier 1): After purge, timeline and reply drafting fall back to `ai_summary` (no blank timeline, no reply built from nothing).
  - RET-3 (Tier 1): **QA-FOLLOWUPS states the purge is currently widened to a 30-day window as a deliberate workaround** (it was erasing timeline history / breaking replies — cases IN-2, IN-3, CL-3). Verify current live behavior matches the documented workaround, and that the public 72h commitment vs. actual config discrepancy is tracked.
  - RET-4: Metadata (subject, participants, ai_summary, FKs) survives the purge indefinitely.
  - RET-5: v1-classified rows without `ai_summary` (KNOWN_ISSUES) — confirm they don't render as empty cards.

### Inbound intent classification
- What it does: `intent` column on `lead_timeline_items`, `classify-inbound` cron (with `intent_version`), classify-outbound, intent sampling; gates the inbound purge and feeds queue filtering.
- Where: Background cron; queue/CommandStrip counts.
- PRs/commits: PR #38 (`35d0268` + `12b48f5` intent column), PR #41 classify-intent sample, PR #42 classify-inbound cron (`e2c5e30`), `38ab62f` classifier JSON parsing, `ca1a7cf` JSON truncation guard.
- Existing tests: none
- Scenarios:
  - INT-1: Fresh inbound → classified within the cron interval, `intent` + `intent_version` + `ai_summary` written.
  - INT-2: Malformed/truncated LLM JSON → parse guard catches it; row retried, not stuck (and not purged unclassified before the 7-day cap).
  - INT-3: `intent_router` may emit values outside the documented vocabulary (KNOWN_ISSUES) — queue filters must not crash on unknown intents.

### Bulk operations + bulk-nurture guardrail
- What it does: 12 bulk surfaces (see BULK_OPS_INVENTORY.md B1–B12); Phase 1.5 added a guarded BulkMoveToNurtureDialog + `leadEligibility.ts` so bulk-nurture can't clobber active leads.
- Where: Dashboard LeadTable + `/app/leads`.
- PRs/commits: PR #40 (`95922cc`); inventory in `35d0268`.
- Existing tests: none
- Scenarios:
  - BULK-1 (Tier 1): Bulk move-to-nurture on a mixed selection → ineligible leads (active convo / recent inbound) excluded with honest count, eligible ones moved.
  - BULK-2: Bulk stage/source change fires without confirmation (KNOWN_ISSUES) — verify current behavior and flag.
  - BULK-3: Bulk delete from both surfaces (Dashboard + /app/leads) behaves identically.
  - BULK-4 (Tier 1): Bulk enable automation respects the consent gate per lead.

### Action queue Phase 2a redesign (Queue page)
- What it does: New queue UI (QueueCard/QueueChips/NewItemsBanner/ShowAllToggle, `useQueueSnapshot`), mark-as-handled RPC + `get_latest_intents_for_leads`, `eligible_at` timezone-correct rendering, resurfaced_at + status-rank guard, voice interactions wired into detection, executor handled-state integration, cleanBodyText for snippet hygiene.
- Where: `/app/queue` (Queue page) + dashboard PriorityActions.
- PRs/commits: PR #43 sync fixes (`2d24b14`, `7c3532c` resurfaced_at, `ddc64bb` status-rank), PR #44 (`3114bf6` mark_action_handled + eligibleAtFormat), PR #45 voice (`97136d5`), PR #46 queue UI (`e5a0afe`), PR #47 executor (`cd774fc`), PR #48 cleanBodyText (`bac162c`).
- Existing tests: `src/lib/dashboardUtils.test.ts`, `src/lib/eligibleAtFormat.test.ts`, `src/lib/cleanBodyText.test.ts`, `src/components/dashboard/TopMovers.test.tsx`
- Scenarios:
  - Q-1: Inbound arrives while queue is open → NewItemsBanner appears; mark-as-handled vs fresh-inbound race resolves in favor of the fresh inbound (EDGE_CASES #3).
  - Q-2: `eligible_at` renders in the workspace timezone, not browser/UTC (EDGE_CASES #11).
  - Q-3: Handled lead resurfaces on new inbound → `resurfaced_at` set; status-rank guard prevents downgrade.
  - Q-4: Queue snippet text is cleaned (no quoted-thread tails, no HTML junk) — cleanBodyText cases.
  - Q-5: SaaS auto-replies (Zendesk/Salesforce) not surfaced as real replies (EDGE_CASES #6 — known false-positive risk via OOO headers).

### Data freshness & reconnect UX
- What it does: Mail/calendar "last synced" chips, MailConnectionBanner for broken connections, DraftCacheInvalidator, draft-cache clear on lead edit and after 3 regenerations, Outlook refetch ConsistencyLevel, refetch engines.
- Where: Dashboard layout, inbox, lead detail tabs.
- PRs/commits: PR #54 (`0a5d938`), PR #51 clear draft cache on lead edit, `fc59f61` 3-regen cache clear, PR #55 + `b610014` refetch engines (06-01), `a6c5ed5` email restore flow.
- Existing tests: none
- Scenarios:
  - FRESH-1: Expired mail connection → banner prompts reconnect; chip shows stale last-synced honestly.
  - FRESH-2: Lead fields edited → cached draft invalidated so the next draft uses fresh context.
  - FRESH-3: Regenerating 3 times → cache cleared, genuinely new draft.

---

## June 2026 — Outreach (cold campaigns) Units A/B/C/D/E

### Outreach Unit A — campaigns foundation
- What it does: Campaign data model (`campaign_type`, `status` draft/active/paused/completed, `knowledge_ref`), member-level RLS (was admin), workspace `campaign_suppression_list`, 3-step wizard, campaign list/detail pages, guarded lead assignment (workspace-scoped + never steal a lead from another campaign), draft campaigns never drive sends (loader gates on `status='active'`).
- Where: `/app/automations` ("Outreach" nav).
- PRs/commits: PR #56 (`d9430d0`) + `6eab08c` migration applied (06-02).
- Existing tests: none directly (loader gate covered by golden tests indirectly)
- Scenarios:
  - OA-1 (Tier 1): Lead added to a DRAFT campaign → executor keeps legacy behavior (loader returns null); activating the campaign switches it over.
  - OA-2 (Tier 1, isolation): multi-workspace rep adding leads → UPDATE constrained to the campaign's own workspace; cross-workspace lead silently skipped with honest count.
  - OA-3: Adding a lead already in another campaign → skipped (never pulled out), skipped count surfaced.
  - OA-4: Suppression list CRUD works; (enforcement is Unit C — see Cold send).

### Outreach Unit B — 9-step resolver + AI content authoring
- What it does: Resolver widened 4→9 steps GATED to structured campaigns with >4 active steps (legacy path byte-identical, golden-tested); `campaign_step_content` per step×variant; AI generation of email/talking-points/voicemail/SMS with 2-option picks; per-industry variants; edits sacred; full-cadence review UI with spam heads-up; KB document scoping via `match_knowledge_chunks_v2(filter_document_id)`; `aiCampaignResolver` fail-closed on workspace membership AND on cross-tenant `knowledge_document_id`.
- Where: `/app/automations/:id` (CampaignContentReview); `ai_task` authoring branch (background).
- PRs/commits: PR #58 (`6466be0`), PR #59 (`db16b32`) + `47e485b` migrations applied (06-03/04); `6facafe` authoring bypass fix, `faa3f57` placeholder substitution, `11355b4` retry token budget, `5b28b2c` ai_task validation (06-06/07).
- Existing tests: `src/lib/__tests__/campaignResolver.golden.test.ts`, `src/lib/__tests__/campaignNineStep.test.ts`
- Scenarios:
  - OB-1 (Tier 1): Golden tests pass — `send_pre_1..4`/`nurture_1..4` byte-identical pre/post widening (live send path).
  - OB-2 (Tier 1, isolation): a crafted `knowledge_document_id` pointing at another tenant's KB chunks → resolver returns null (fail-closed), no foreign KB text in output.
  - OB-3: Bulk generation never overwrites an edited touch; only per-touch Rewrite forces regeneration; picking an option never wipes an edit.
  - OB-4: Industry variant resolution — lead industry matches variant_group, else General/NULL fallback.
  - OB-5: Non-campaign drafting payloads (no campaign_id) take the legacy path untouched.

### Outreach Unit D — collateral generator + asset storage
- What it does: AI-drafted, rep-editable one-pagers and technical walkthroughs per campaign×industry (drafts only, never auto-sent), grounded ONLY in seller instructions + KB doc (never customer bodies); "link to an email" affordance; later: storage bucket for collateral file assets.
- Where: `/app/automations/:id` (CampaignCollateralSection).
- PRs/commits: PR #60 (`748d180`→`748c…`, `2c57349` SQL applied, 06-04), PR #80 collateral-asset-storage (`51485df`) + `21ae158`/`8c9a5ed` bucket privacy fix (06-10/11).
- Existing tests: none
- Scenarios:
  - OD-1 (Tier 1, send-adjacent): `automation-executor` can never enter the ai_task authoring path (collateral allowlist + no top-level step_number) — the gate change was QA-flagged.
  - OD-2 (Tier 1, retention): generated collateral contains zero customer message content (built only from instructions + KB).
  - OD-3 (Tier 1, isolation): collateral storage bucket is **public-by-link read by design** (`public=true`) — briefs are linked in cold emails and must open for an unauthenticated prospect via an unguessable UUID path, so briefs must never contain workspace-confidential data. The REAL privacy boundary is **member-scoped write**: only workspace members may upload/replace/delete, scoped by path segment 1 = workspace_id, and the `TO service_role` clause on the manage policy is load-bearing (`8c9a5ed`). Verify the 5 `storage.objects` collateral policies are member-scoped; do NOT expect the bucket itself to be private. (See "Known deliberate deviations".)
  - OD-4: Edits sacred — regenerate requires confirm when `is_edited`.

### Outreach queue tabs (Unit E relabel)
- What it does: Queue re-organized into Replied / Follow up / Outreach tabs (OOO folded into Follow up as UI grouping only); underlying `queueQueries` bucket logic byte-unchanged.
- Where: `/app/queue`.
- PRs/commits: PR #61 (`e08bbf9`, 06-04), PR #65 (OutreachCard tab content).
- Existing tests: none
- Scenarios:
  - OE-1: Items distribute correctly: Replied→replied, Follow up→(followup_due ∪ ooo_back), Outreach→cold touches.
  - OE-2: OOO detection/pause behavior unchanged by the relabel (UI-only fold).

### Outreach Unit C — cold send engine (enrollments + touches) — Tier 1 (send)
- What it does: `campaign_enrollment` + `campaign_touch` source of truth; business-day staggered enrollment with per-mailbox cap + capacity preview; executor sends due AUTOMATIC email touches directly (per-touch claim `cold_touch_<id>`, fresh re-check, lock-step `current_step_number`); `campaign-touch-scheduler` cron owns manual/review surfacing + auto-skip + reply-bridge; single sender `sendColdEmailTouch` with STRUCTURAL fail-closed floor (suppression + unsubscribed + postal address + email-validity backstop) inside the shared module; `send_mode` review vs automatic; `cold_auto_send_enabled` workspace gate (default false); pause/stop via `campaigns.status`; v1 safety: email validation at import, recipient-timezone sending (`timezone_mode:"lead"`), bounce-rate circuit breaker auto-pausing campaigns.
- Where: Background (executor + scheduler crons); Settings ColdOutreachSafetyCard; campaign detail pause/stop.
- PRs/commits: PR #63 schema (`6396496`), PR #64 cold send (`549c225`), PR #65 queue UI (`1114ef1`), PR #66 safety (`b5d4efb`), migrations `20260606000000/000100/000200` (`622f1cb`, `e5bd092`); `fedd215` PR #69 cold-pass overfetch fix.
- Existing tests: `src/lib/campaignEnrollment.test.ts`, `src/lib/emailValidation.test.ts`
- Scenarios:
  - OC-1 (Tier 1): Two executor runs racing on the same due touch → exactly one send (`cold_touch_<id>` claim); no same-run bunching (fresh-touch re-check).
  - OC-2 (Tier 1): Suppressed, unsubscribed, or invalid-email lead → `sendColdEmailTouch` refuses for EVERY caller (automatic, review Send, manual) — structural floor.
  - OC-3 (Tier 1): No workspace postal address OR `UNSUBSCRIBE_TOKEN_SECRET` unset → zero cold sends (fail-closed).
  - OC-4 (Tier 1): Reply from an enrolled lead → enrollment stops/bridges (reply-stop gate); bounce stamps `bounced_at` and stops the enrollment; aggregate bounce rate past threshold auto-pauses the whole campaign + `volume_alert`.
  - OC-5: Pause/Stop flips `campaigns.status` → scheduler AND executor halt immediately; steps 5–9 advance natively in lock-step (only current+1 ever ready).
  - OC-6 (Tier 1): `timezone_mode:"lead"` → send lands in the prospect's local morning; otherwise workspace TZ; lead-TZ unresolvable → workspace fallback.
  - OC-7 (Tier 1): MEMORY note — Unit C is merged but **NOT safe for auto-send** until the 4 gates pass (reply-stop, soft bounce, tests, spam complaints). Verify `cold_auto_send_enabled` is still false everywhere in prod. NOTE: the "soft bounce" gate is now addressed by the Unit 2 classifier below (PR #89).

### Soft vs hard bounce classification (Unit 2) — Tier 1 (send/suppression)
- What it does: `_shared/bounceDetection.ts:classifyBounce` parses the RFC 3463 enhanced status code from a DSN (canonical `Status:` field or inline next to the SMTP reply code, e.g. `550 5.1.1`). gmail-sync / outlook-sync gate the permanent-suppression block on it: 5.x.x (hard) suppresses the lead + ends the enrollment + stamps `bounced_at` (circuit-breaker numerator); 4.x.x (soft/transient) does NONE of that and leaves the cadence to retry. No code → narrow clearly-permanent keyword fallback, else fail-safe transient. Replaces the old keyword-only logic that permanently killed a lead on ANY bounce keyword, including soft bounces.
- Where: Background (gmail-sync, outlook-sync). Pure classifier in `_shared`.
- PRs/commits: PR #89.
- Existing tests: `supabase/functions/_shared/bounceDetection.test.ts` (Deno), `src/lib/__tests__/bounceClassification.test.ts` (vitest).
- Scenarios:
  - SHB-1 (Tier 1): Hard bounce — point Bounced Ben at an address that returns a 5.x.x DSN (`550 5.1.1` user unknown); sync. Pass when: Ben marked `unsubscribed`, enrollment `stopped` with `bounced_at` set, pending touches skipped, DSN NOT stored as an outbound. (Regression of AE-4 / OC-4 — hard path must still fire.)
  - SHB-2 (Tier 1): Soft bounce — return a 4.x.x DSN (`452 4.2.2` mailbox full / greylisting) to a fresh enrolled lead; sync. Pass when: lead NOT unsubscribed, enrollment NOT ended (`bounced_at` stays null), the next due touch still sends on schedule, and the soft DSN does not count toward the campaign bounce rate.
  - SHB-3 (Tier 1): Circuit breaker counts HARD only — drive a campaign's bounce rate with a MIX of soft + hard DSNs. Pass when: only the 5.x.x ones move the breaker numerator; an all-soft batch never auto-pauses the campaign.
  - SHB-4 (Tier 1): Fail-safe transient — a generic "Undeliverable"/"Delivery Status Notification (Failure)" DSN with NO status code and no clearly-permanent phrase. Pass when: lead survives (treated as soft). Contrast: a no-code DSN whose body says "no such user" → treated as hard.

### Cold outreach unsubscribe + CAN-SPAM — Tier 1 (send/compliance)
- What it does: CAN-SPAM footer with postal address + `List-Unsubscribe` header (Gmail via additive `headers` param; Outlook body link), public `outreach-unsubscribe` endpoint keyed on HMAC token (≥30-day validity); inbound unsubscribe detection with quoted-thread false-positive fix and attribution-line/blank-line handling.
- Where: Background (cold sender); public unsubscribe page; sync-time detection.
- PRs/commits: part of PR #64; PR #68 quoted-thread fix (`4973004`, FIXED 2026-06-08 per KNOWN_ISSUES), PR #70 attribution blank line (`02bd9c4`).
- Existing tests: `supabase/functions/_shared/unsubscribeDetection.test.ts`
- Scenarios:
  - UNS-1 (Tier 1): Cold email always carries footer + List-Unsubscribe; Gmail threading byte-unchanged by the headers param (QA-passed claim — regression-check).
  - UNS-2 (Tier 1): Clicking unsubscribe with a valid token → lead marked unsubscribed, all future sends blocked; tampered/expired token rejected; missing secret → endpoint fails closed.
  - UNS-3: Reply quoting an email that contains the word "unsubscribe" in the quoted thread → NOT flagged as an unsubscribe (the fixed false positive).
  - UNS-4: "On <date>, X wrote:" attribution followed by blank line → detection still correct (PR #70).

### Outreach queue cards (review/manual touches + device call)
- What it does: OutreachCard with one primary action per channel — Call (`tel:` or in-app), Text (`sms:` prefilled), WhatsApp (`wa.me`), LinkedIn (clipboard+open); review-mode email Send→preview→send; all actions funnel through `outreach-touch-action` edge fn (user-auth, idempotent on `queued`); content resolver fix for review cards; device-call option using the rep's own number (`repCallerNumber`).
- Where: `/app/queue` Outreach tab.
- PRs/commits: PR #65, PR #71 review-card content resolver (`2ac784d`), PR #73 device call (`c790d24`).
- Existing tests: none
- Scenarios:
  - OQ-1 (Tier 1): Review "Send" double-click → exactly one send (touch must be `queued`); send routes ONLY through `sendColdEmailTouch` (no client send path).
  - OQ-2: Manual touch (text/WhatsApp/LinkedIn) → "Sent it" never auto-marks; skip is quiet secondary.
  - OQ-3: Review card preview shows the resolved per-touch content (right step, right industry variant) — PR #71 regression.
  - OQ-4 (Tier 1, isolation): `outreach-touch-action` asserts workspace membership; foreign touch id rejected.

### Campaign KB grounding for live sends + no-file fallback — Tier 1 (send)
- What it does: Live cold sends are grounded in the campaign's KB document (`campaignKnowledgeDoc` threaded through executor → ai_task); when a campaign has no KB file, a scoped fallback (`campaignKbScope`) keeps retrieval inside the right workspace/user scope instead of leaking or going ungrounded.
- Where: Background (`automation-executor`, `ai_task`).
- PRs/commits: PR #75 kb-nofile-fallback (`c48a0f9`), PR #78 livesend-campaign-kb (`4af0d74`), KNOWN_ISSUES "KB is user-scoped, not workspace-scoped" caveat.
- Existing tests: `supabase/functions/_shared/campaignKbScope.test.ts`, `supabase/functions/_shared/campaignKnowledgeDoc.test.ts`
- Scenarios:
  - OKB-1 (Tier 1): Campaign with KB doc → live-send drafts cite that doc's content; doc deleted/empty → fail-safe (generic but sendable, or skip — verify chosen behavior).
  - OKB-2 (Tier 1, isolation): no-file fallback never retrieves chunks owned by users outside the campaign's workspace (KB is user-scoped — the documented hazard).
  - OKB-3: Loader/resolver changes leave non-campaign send paths untouched (PR #78 touched `automation-executor`).

### Campaign scorecard rollup
- What it does: Per-campaign performance rollup (sends, replies, bounces, etc.) via a SQL RPC + query layer.
- Where: Campaign detail page (`/app/automations/:id`).
- PRs/commits: PR #79 (`17e7a5d`) + `21ae158` RPC migration applied (06-10/11).
- Existing tests: none
- Scenarios:
  - SCR-1: Scorecard numbers match raw `campaign_touch`/`campaign_enrollment` counts for a known fixture campaign.
  - SCR-2 (Tier 1, isolation): RPC only aggregates campaigns in the caller's workspace.
  - SCR-3: Empty/new campaign → zeros, not errors.

### Pending lead profile extraction
- What it does: `extract-lead-profile` edge function builds an AI profile for pending/approved leads, surfaced in the LeadContextPanel.
- Where: Lead detail LeadContextPanel; `extract-lead-profile` edge fn.
- PRs/commits: PR #81 (`7dae115`, 06-11); related earlier `extract-profile-from-kb` (CLAUDE.md not-ghost-code list).
- Existing tests: none
- Scenarios:
  - PLX-1: Pending lead with email history → profile extracted and rendered; lead with no data → graceful empty state.
  - PLX-2 (Tier 1, retention): extraction reads available bodies/summaries but must not persist raw customer bodies anywhere durable beyond the purge rules.
  - PLX-3 (Tier 1, isolation): function rejects lead ids outside the caller's workspace.

### Cold template tightening + eval harness
- What it does: Tightened cold-email prompt template (with an eval script `__evals__/coldTemplateEval.ts`), plus drafter context and reply-prompt fixes.
- Where: Background (`_shared/prompts.ts`).
- PRs/commits: PR #82 (`d4453cc`, 06-11), PR #74 drafter context & reply prompt (`a5c5cf6`).
- Existing tests: `supabase/functions/_shared/__evals__/coldTemplateEval.ts` (eval harness, not vitest)
- Scenarios:
  - CT-1 (Tier 1): Run the eval harness — cold drafts meet the template constraints (length, structure, no placeholder leakage after `faa3f57` substitution).
  - CT-2: Reply prompts receive the fixed drafter context (PR #74) — replies reference the actual inbound, not stale context.

### Twilio hardening (SMS / WhatsApp / calls) — Tier 1 (send)
- What it does: Hardened Twilio integration across browser calls (BrowserCallProvider), ASR provider, WhatsApp provider types, call-ingest/transcribe, sms-send; removed weak `twilioSignature` helper; API-keys migration task documented.
- Where: Background edge functions + call UI.
- PRs/commits: PR #67 (`e451465`, 06-09) + TWILIO_*.md docs; `b5b4c0f` OAuth token leak & snooping fix (06-09).
- Existing tests: none
- Scenarios:
  - TWH-1 (Tier 1): All inbound Twilio webhooks (SMS, voice, status, WhatsApp) reject invalid signatures post-refactor.
  - TWH-2 (Tier 1): `sms-send` and WhatsApp provider still deliver after hardening (no auth regression); errors surface diagnostic codes (`0409af9`).
  - TWH-3: `b5b4c0f` — verify OAuth tokens no longer leak in logs/responses and the snooping vector is closed (regression test).

### Outreach Unit 0 placeholder substitution & authoring guards (misc direct pushes)
- What it does: Cluster of direct-to-main fixes around Unit B/C cutover: placeholder substitution in generated content, campaign authoring bypass fix, ai_task validation patch, retry token budget.
- Where: Background (`ai_task`).
- PRs/commits: `faa3f57`, `6facafe`, `5b28b2c`, `11355b4` (06-06/07).
- Existing tests: none
- Scenarios:
  - MISC-1 (Tier 1): No `{{placeholder}}` tokens ever reach a sent email (substitution + validation).
  - MISC-2: Authoring requests can't bypass the campaign membership gate (`6facafe` regression).

### Outreach wizard — flyer upload to campaign knowledge (PR #93)
- What it does: The New-outreach wizard's optional flyer/one-pager attachment now actually uploads. The wizard keeps the real `File`; after the campaign is created in Step 3 it extracts the file text and routes it through `ingestCampaignKnowledge` — the SAME path as the campaign page's "Add knowledge file" button (`process-knowledge-document`, `source = campaign:<id>`, company-collateral guardrail). Best-effort: a file it can't read never rolls back the save (`knowledge_ref` set only on success). Also fixes two over-promising copy lines ("By industry … set this up next" → after saving; Step 2 "wording written in the next step" → reviewed/edited after saving). NOTE: the shared ingest path is **plain-text only** (`file.text()`, `accept=".txt,.md,.csv,.text"`) — there is NO PDF/Word text extraction, so non-text files fall through to the "couldn't read that file" path by design.
- Where: `/app/automations/new` Step 1 (attach) + Step 3 confirm (`src/pages/NewCampaign.tsx`); `ingestCampaignKnowledge` (`src/lib/generateCampaignContent.ts`); `process-knowledge-document` edge fn.
- PRs/commits: PR #93 (`6597eca`).
- Existing tests: `src/pages/NewCampaign.test.tsx` (ingest invoked with the extracted text; a failed flyer does not roll back; no-flyer leaves the knowledge path untouched).
- Scenarios:
  - OW-FLY-1 (happy): Rep A creates an outreach, attaches a text-based flyer (`.txt`/`.md`/`.csv` — see note), saves. Pass when: saved as draft; the flyer shows as attached on the campaign page (`knowledge_ref` + `knowledge_document_id` set); generated messages reference the flyer's actual wording.
  - OW-FLY-2 (unreadable file): attach a scanned/image-only PDF, a Word doc, or any file with <50 readable chars. Pass when: the outreach still saves; a non-blocking "Saved — but we couldn't read that file…" toast appears; `knowledge_ref` stays null (nothing recorded); the campaign is NOT rolled back.
  - OW-FLY-3 (no flyer): save with no file attached. Pass when: saves normally; `ingestCampaignKnowledge` is never called; the knowledge store is untouched.

### Outreach wizard — LinkedIn as a manual cadence channel (PR #94)
- What it does: LinkedIn becomes a first-class MANUAL cadence channel. `linkedin` added to `CanonicalChannel`; the default 9-touch plan interleaves 3 manual LinkedIn touches (connection request, react-to-their-post, follow-up message) WITHOUT growing past 9; plan rows get distinct labels via `touchLabel(channel, step_type)`; AI authoring generates LinkedIn copy (`linkedin_connect` / `linkedin_reaction` / `linkedin_followup`); the Queue runs LinkedIn touches by hand (copy message + open profile), and a touch with no profile URL is Skip-only. LinkedIn is ALWAYS manual — never auto-sent, never scraped.
- Where: wizard channel picker + Step 2 plan (`src/lib/campaignDefaults.ts` — `buildDefaultPlan`, `touchLabel`); `src/lib/generateCampaignContent.ts` (authoring); `OutreachCard` / `src/components/lead/LinkedInMessageButton.tsx` (Queue); `src/prompts/linkedinPrompts.ts`.
- PRs/commits: PR #94 — `b22ff5b`, `6acd182`, `5107c30`, `9c480a8`.
- Existing tests: `src/lib/__tests__/linkedinCadence.test.ts` (9-touch count, 3 LinkedIn touches, distinct labels, step_type→task mapping).
- Scenarios:
  - OW-LI-1 (happy, has profile): outreach with LinkedIn selected; enroll a lead with a LinkedIn URL (give Eligible Ed one). In the Queue, the LinkedIn touch copies the prepared message and opens the profile; "Mark done" advances the plan. Pass when: copy + open both work; the touch completes and the cadence advances.
  - OW-LI-2 (no profile): enroll a lead with no LinkedIn URL. Pass when: the Queue shows "No profile", the touch is skip-only, and it can't be marked sent (`5107c30`).
  - OW-LI-3 (plan length — REGRESSION): an email-only outreach builds exactly 9 touches; one with LinkedIn selected still builds exactly 9 touches, including 3 LinkedIn. Pass when: never 12. Named regression for the 12→9 fix (`9c480a8`) — the plan must never silently grow back to 12.
  - OW-LI-4 (distinct labels): in Step 2, the three LinkedIn touches read as "Connect on LinkedIn", "React to their post", and "LinkedIn message" — not three identical "LinkedIn" rows.

### Lead Detail redesign — Unit 3: slim the right rail (PR #112) — Tier 2 (automation-control-adjacent)
- What it does: Trims the Lead Detail page so a rep sees only what helps the next move. The right rail now shows just an Automation on/off toggle (one-line plain status) and the latest meeting recap. The duplicate "Company Signals / Enrich" block and the duplicate "Run Analysis / Analyzed X ago" control are hidden on this page (the plain-English Summary stays). The right-rail Signals & Risks is dropped (canonical copy stays in the Intelligence card). Stakeholders/Partners, Lead Context, Deep Analysis, Upload, and a review-only Saved Drafts pane move behind a single "More" menu. A stakeholder avatar row appears in the header only for 2+ person deals. The automation enable/disable logic was extracted verbatim to `src/lib/leadAutomationActions.ts` (no logic change); the toggle refuses to turn ON while a safety blocker (reply / booked meeting / closed / motion change) is present.
- Where: `src/pages/LeadDetail.tsx`, `src/components/lead/{AutomationToggleCard,AutomationPreviewCard,LeadOverviewPanel,LeadDetailHeader,StakeholderAvatarRow,DraftsTab}.tsx`, `src/components/leads/UnifiedIntelligenceCard.tsx`, `src/lib/leadAutomationActions.ts`.
- PRs/commits: PR #112.
- Existing tests: `src/lib/leadAutomationActions.test.ts` (enable/disable/blocker field parity).
- Scenarios:
  - LD3-1 (solo lead): open a solo lead (no group). Pass when: header shows NO avatar row; the right rail shows only Automation + Latest Meeting (no empty Stakeholders/Partners/Lead-Context boxes); "Add person" is reachable via More → People & partners.
  - LD3-2 (2+ person deal): open a lead in a group of 2+ (Group-thread Gina's group). Pass when: a small avatar row appears in the header, the champion is flagged, each avatar links to that person's lead page, and ONLY same-dealership people appear (isolation).
  - LD3-3 (Tier 2, automation OFF→ON): on a clean eligible lead (Eligible Ed), flip Automation on and confirm. Pass when: it schedules the next step (toast), the switch reads On, and the lead has `automation_mode = full_auto`. Flipping off clears the sequence AND `automation_mode` (sends stop).
  - LD3-4 (Tier 2, safety — must hold): on Replied Rita (or a lead with a booked meeting), try to flip Automation ON. Pass when: it is REFUSED with a plain message ("Can't turn on — lead has replied"), `automation_mode` stays null, no step is scheduled. Proves the toggle can't re-arm a paused-by-safety lead.
  - LD3-5 (automation Details): expand the toggle's "Details". Pass when: the full controls (scheduled steps, Preview, Pause/Resume/Stop) are present and still work — nothing deleted, just hidden.
  - LD3-6 (More menu, no 404): click through More → Saved drafts / Meetings / People & partners / Lead context / Deep analysis / Upload. Pass when: each opens its pane; the Saved Drafts pane is review-only (Copy / Send / Mark sent — NO composer) so "Draft it" stays the single compose entry; the meeting card's "See all meetings" link lands on the Meetings pane (booking stays reachable).
  - LD3-7 (meeting date dedup): open a lead whose latest meeting was auto-titled ("Meeting — <date>"). Pass when: the latest-meeting header shows the date once, not "Jun 17, 2026 — Meeting — Jun 17, 2026".

### Outreach Unit 2 — full touch editor + per-step meeting link (PR #114)
- What it does: Turns the New-outreach **Step 2** plan from "nudge day-gaps + remove" into a full editor. A rep can add a step anywhere (email / call / text), reorder with up/down arrows, change a step's channel, remove a step, edit timing, and tick "Include a meeting link" on EMAIL steps. Adds a nullable column `campaign_steps.include_meeting_cta` (null = inherit `campaigns.include_meeting_cta` = today's behavior) — the per-step source of truth a later generation unit reads. Pure gap-chain helpers in `campaignDefaults.ts` recompute the schedule on every edit: first touch always day 0; deleting a mid-step rolls its gap into the next so later landing days are preserved; reordering keeps per-slot gaps (schedule rhythm unchanged); insert (front OR middle) shifts later touches out by the new touch's gap. Calls/texts stay MANUAL — adding them never routes into auto-send (the sender is untouched and still email-only). No per-step template field: the live email template fires by sequence position, so the editor keeps each email's step_type/cta_type coherent with position and shows plain-language intent ("first message / follow-up / last message"). SMS steps require `workspaces.sms_enabled` — the add/change Text options disable with an inline hint, and an existing text step is FLAGGED inline, never dropped.
- Where: `/app/automations/new` Step 2 (`src/pages/NewCampaign.tsx`); `src/components/automations/CampaignScript.tsx` (editable mode); `src/lib/campaignDefaults.ts` (insert/remove/move/changeChannel/setGap/setMeetingCta + normalizePlan); `src/lib/campaignQueries.ts` (`draftStepToRow` + `CampaignStep`/`DraftCampaignStep` carry the new column). Migration `20260624000000_campaign_step_meeting_cta.sql`.
- PRs/commits: PR #114.
- Existing tests: `src/lib/__tests__/campaignPlanEditing.test.ts` (insert call between two emails; reorder keeps landing days; change-channel updates the stored channel and preserves the schedule; SMS-off flagged-not-dropped; meeting flag persists via `draftStepToRow`; delete preserves later days; first-touch day-0; front-insert no day-0 collision).
- Scenarios:
  - OW-EDIT-1 (happy, build): Rep A → "Build my outreach" → Step 2. Add a call between emails 1 and 2; move it up; change a text to an email; tick "Include a meeting link" on emails 2 and 3 only; save. Pass when: the draft saves with steps in the edited order; gap days look sensible (first = day 0); exactly emails 2 and 3 have the meeting flag persisted.
  - OW-EDIT-2 (Tier 1 — additive migration / isolation): after the migration applies on staging, an existing campaign's steps are unchanged (`include_meeting_cta` reads null = inherit). A member of Dealership A can read AND write the new column on their own campaign's steps; a Dealership B rep cannot read or write Dealership A's steps. Pass when: existing rows untouched, member read/write works, cross-dealership access denied.
  - OW-EDIT-3 (schedule integrity — REGRESSION): in Step 2, note the day each touch lands; delete a middle touch. Pass when: the touches AFTER the deleted one keep the SAME landing days (the removed gap rolls forward — they don't slide earlier), and the first touch is still day 0. Named regression for the gap-chain math.
  - OW-EDIT-4 (front-insert — REGRESSION): add a step at the very TOP of the plan. Pass when: the new step is day 0 and every existing touch shifts out by the new touch's gap (no two touches collide on day 0). Named regression for the front-insert fix.
  - OW-EDIT-5 (stays manual): build a plan with a call and a text, save, then enroll a lead. Pass when: nothing auto-sends; the draft stays review/manual (`send_mode` unchanged); the call/text appear as manual Queue touches, never auto-sent.
  - OW-EDIT-6 (SMS gating): with `workspaces.sms_enabled` OFF, the "Add a text" / "Change to a text" options are disabled with a "set up texting" hint; a plan that already contains a text step shows the inline "texting isn't set up" flag and does NOT crash or drop the step.
  - OW-EDIT-7 (meeting flag is store-only at this stage — NOT A BUG): ticking "Include a meeting link" persists the flag but does NOT yet change the generated email — reading it at generation is a later unit. **SUPERSEDED by Unit 3 below (PR per-step-meeting-cta): the flag now DOES drive the draft.**

### Outreach Unit 3 — per-step meeting link injected per-rep at send — Tier 1 (email send + ISOLATION)
- What it does: Makes `campaign_steps.include_meeting_cta` actually drive the email (Unit 2 only stored it). The decision collapses via `resolveStepMeetingCta` (`true`→force on, `false`→off, `null`→inherit). **Key design (cross-rep safety):** authored cold copy in `campaign_step_content` is WORKSPACE-SHARED and shipped as-is by the cold sender, so a rep's booking link is **never baked into it**. Instead `resolveTouchContent` appends the **LEAD OWNER's OWN** `rep_profiles.calendar_link` at SEND time, gated by the fresh per-step flag — so the same shared copy yields rep A's link for A's leads and rep B's link for B's leads (no leak). Cold sends carried no link before, so only an explicit tick (force_on) adds one; `null`/`false` stay link-free (byte-unchanged). No owner link → CTA omitted cleanly (no placeholder). The per-lead **regeneration** path (`automation-executor` legacy branch) gates its own `meeting_link`/rep-context on the same decision (per-rep, regenerated — `null` byte-unchanged, golden-tested) and a `force_on` step adds a hard rule so the link survives the intro template's "no calendar links unless instructed" guard; an inbound step explicitly OFF no longer leaks the URL via the inbound `cta_type`. A typed instruction "add the meeting link to every email" is a shortcut (`detectMeetingCtaIntent`/`applyMeetingCtaIntent`) that pre-ticks every email step; a NEGATED universal ("don't add the meeting link to every email") un-ticks them; specific-email/soft asks change nothing (rep uses the checkboxes). The cadence-content review shows a "meeting link" badge on flagged email steps.
- Where: Send-time `supabase/functions/_shared/coldOutreach.ts:resolveTouchContent` (+ `meetingCtaLine.ts`), callers `automation-executor`/`outreach-touch-action` pass `owner_user_id`. Decision in `campaignResolver.ts` (+ client mirror); loader `campaignStepLoader.ts`/`campaignStepConfig.ts`; shortcut `campaignDefaults.ts` wired in `NewCampaign.tsx`; badge in `CampaignContentReview.tsx`. Authoring (`aiCampaignResolver.ts`/`ai_task`) deliberately stays link-free.
- PRs/commits: PR per-step-meeting-cta (this PR).
- Existing tests: `src/lib/__tests__/perStepMeetingCta.test.ts` (vitest — decision + shortcut), `supabase/functions/_shared/campaignMeetingCta.test.ts` (Deno — send-time append + cross-rep no-leak), golden tests stay green (regeneration `null` byte-identical).
- Scenarios:
  - PSM-1 (Tier 1 — happy): On Eligible Ed's active campaign, tick "Include a meeting link" on emails 2 and 3 only. Let the cold sender send (or review-send). Pass when: emails 2 and 3 carry Ed's `calendar_link` (appended as a CTA line); emails 1 and 4 carry NO booking link.
  - PSM-2 (Tier 1 — instruction shortcut): New outreach, instructions include "add the meeting link to every email". Build → Step 2. Pass when: every EMAIL step's "Include a meeting link" box is pre-ticked (calls/texts untouched); a NEGATED version ("don't add the meeting link to every email") leaves them all UN-ticked.
  - PSM-3 (Tier 1 — ISOLATION, cross-rep no-leak — load-bearing): One workspace, a campaign with email step 2 flagged ON, two reps (A, B) who each own some enrolled leads and each have a DIFFERENT `calendar_link`. Send to an A-owned and a B-owned lead. Pass when: the A-owned email contains ONLY A's link and the B-owned email ONLY B's link; the stored `campaign_step_content.body` contains NO booking URL at all (the link is added per-send, never baked).
  - PSM-4 (Tier 1 — no calendar link): lead owner has an empty `rep_profiles.calendar_link`, email step flagged ON. Pass when: the sent email has NO booking link and NO placeholder/broken text — the CTA is simply omitted.
  - PSM-5 (Tier 1 — byte-unchanged on cold): a campaign whose email steps are all left default (null). Pass when: sent cold emails are unchanged from before this PR — no booking link appears on any step (cold sends never carried one).
  - PSM-6 (review preview == send): in review mode, preview a flagged-ON touch then send it. Pass when: the previewed body and the sent body both contain the lead-owner's link (review uses the same `resolveTouchContent`).
  - PSM-7 (meeting already booked): a lead with `has_future_meeting=true` on a flagged step (regeneration path). Pass when: the draft does NOT ask for a new meeting AND gets no "include the booking link" force rule (the booked-suppression wins).
  - PSM-8 (auto-send gating unchanged — REGRESSION): cold-send consent gate, suppression/unsubscribe floor, OOO/dedup unchanged. Pass when: OC-2/OC-3 still hold; this PR only adds (or omits) a per-rep link line, never changes WHETHER a send is allowed, and the CAN-SPAM footer still follows the appended CTA.
  - PSM-9 (Tier 1 — review-mode shows the CTA, never mutates after review): for a flagged-ON email touch the Queue review body already INCLUDES the booking link (appended in the `fetchOutreachQueue` preview mirror), so the rep SEES it, can edit/move/remove it, and the send ships the reviewed body verbatim — the sender does NOT silently add a P.S. after approval. Pass when: a flagged-ON review card shows the link in the editable body; deleting it before send actually sends without it; an unflagged card shows none. ISOLATION: an admin viewing a COWORKER's touch never sees their OWN link on it (preview link is gated to `lead.owner_user_id === me`).

---

## Existing unit test map

All vitest unless noted. Run with `npx vitest run` from repo root.

| Test file | Covers | Feature section |
|---|---|---|
| `src/lib/__tests__/campaignResolver.golden.test.ts` | Steps 1–4 resolve byte-identical (golden snapshots) | Structured campaigns; Unit B |
| `src/lib/__tests__/campaignNineStep.test.ts` | 4→9 widening gating for structured campaigns | Unit B |
| `src/lib/campaignEnrollment.test.ts` | Enrollment pacing, capacity preview, fail-closed enroll | Unit C cold send |
| `src/lib/emailValidation.test.ts` | Syntactic validity + junk/role/throwaway flagging | Lead import; Unit C-4 safety |
| `src/lib/cleanBodyText.test.ts` | Snippet/body cleaning for queue + summaries | Action queue 2a; rich summaries |
| `src/lib/dashboardUtils.test.ts` | Dashboard metric helpers | Action queue 2a / dashboard |
| `src/lib/eligibleAtFormat.test.ts` | Timezone-correct `eligible_at` rendering | Action queue 2a |
| `src/components/dashboard/TopMovers.test.tsx` | TopMovers dashboard widget (pre-March component, tests added in 2a era) | Dashboard |
| `src/test/integration/rlsIsolation.test.ts` (+ `setup.ts`) | Cross-workspace isolation (IS-1..IS-5) — `npm run test:isolation`, passed live on staging 2026-06-11 | Multi-tenant isolation |
| `supabase/functions/_shared/unsubscribeDetection.test.ts` | Unsubscribe detection incl. quoted-thread false positive | Cold unsubscribe |
| `supabase/functions/_shared/campaignKbScope.test.ts` | KB scope fallback when campaign has no file | Campaign KB grounding |
| `supabase/functions/_shared/campaignKnowledgeDoc.test.ts` | Campaign KB doc resolution for live sends | Campaign KB grounding |
| `supabase/functions/_shared/__evals__/coldTemplateEval.ts` | Cold template prompt eval (harness, not vitest) | Cold template tightening |

Everything else — voice/calls, SMS/WhatsApp sends, Outlook/Gmail sync, retention purge, lead candidates, meetings, stakeholders, bulk ops, safety floor (consent gate / timezone window / cooldown / tripwire), unsubscribe endpoint, scorecard — has **no automated tests** and is manual-QA-only today. Prioritize Tier 1 gaps: retention purge behavior (incl. the 30-day workaround discrepancy), executor double-send claims, the structural cold-send floor, and workspace isolation on every new RPC.

---

# Part 3 — Maintaining this plan

- **Every merged PR appends scenarios** for its feature to Part 2 (or extends Part 1 if it touches a guardrail). This is a required step of PR review — the drivepilot-qa skill enforces it.
- Scenario IDs are stable; never renumber. New scenarios for an existing feature continue its sequence.
- When a bug from BUGS.md is fixed and verified, add a regression scenario named after the bug ID.
- Deliberate deviations (like the 30-day deletion window) are documented in "Test environment" above — keep that list current so the agent doesn't re-file them.
