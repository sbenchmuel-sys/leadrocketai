# BUGS.md — centralized QA bug ledger

One place for every bug the QA agent (or anyone) finds. Claude Code: pick open bugs top-down by severity; each entry ends with a ready-to-use fix prompt. When you fix one, set status to `fixed` — the nightly QA run re-tests it and promotes it to `verified` (or reopens it).

**Severity:** P0 = wrong send possible / cross-dealership leak / broken public promise. P1 = core flow broken. P2 = degraded but usable. P3 = cosmetic.
**Status flow:** `open` → `fixed` (by Claude Code) → `verified` (by QA re-test) | `reopened`. `deferred` = deliberately not fixing now — do not pick up without reading the note.

---

## BUG-001 — mail_accounts login tokens may be stored unencrypted
- **Severity:** P0 (suspected — unconfirmed)
- **Status:** fixed (2026-06-12) — all `mail_accounts` AND `gmail_connections` token writes now encrypt unconditionally and fail closed if `TOKEN_ENCRYPTION_KEY` is missing (previously they silently stored plaintext). New tests: `supabase/functions/_shared/encryption.test.ts` (helper behavior) + `src/test/mailAccountsTokenEncryption.test.ts` (static guard that fails `npm test` if any token write bypasses `encryptToken`). Legacy rows written while the escape hatch existed may still be plaintext — re-encryption backfill plan recorded in CLEANUP.md. **Pre-deploy check:** confirm `TOKEN_ENCRYPTION_KEY` is set in the live project; with the key absent, connect/refresh flows now fail visibly instead of storing plaintext.
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
- **Status:** fixed (2026-06-12, PR #85) — `automation_mode?: string | null` declared on `EnrichedLead`, `as any` casts removed in `classifyRevenueState` + test. `tsc -p tsconfig.app.json` clean.
- **Found:** 2026-06-11, test-suite run (`tsc` project check)
- **What happens:** `classifyRevenueState` in `src/lib/dashboardUtils.ts` reads the consent gate via `(lead as any).automation_mode` — the field exists at runtime but was never declared on the type, producing 1 tsc error in `dashboardUtils.test.ts` and an `as any` cast in production code.
- **Claude Code prompt:** "Add `automation_mode` to the `EnrichedLead`/`LeadListItem` type(s), remove the `as any` cast in `classifyRevenueState` (src/lib/dashboardUtils.ts), and confirm `npx tsc -p tsconfig.app.json` is clean and the dashboardUtils tests still pass."

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
