# DrivePilot master upgrade — checkpoint

Updated: 2026-09-08 00:45 (Israel time) · origin/main recorded at `f75a3ce9` ("Fix/outreach sprint 2 (#135)") · orchestrator running in the cloud workspace; repo cloned from `sbenchmuel-sys/leadrocketai`.

## OBSERVE — things only you can see or hear (each unblocks one PR)
_Nothing yet. The first item will be the G-C one: one executor tick under 55s, one email in your inbox with exactly one signature and one footer, and the kill switch sending zero._

## PRODUCTION — do in Lovable, in this order (batched; staging never waits for this)
_Nothing merged yet._

## DECIDE — defaults I took, and what you still need to give me
1. **Network access for staging (blocking every QA gate, not blocking building).** This workspace's network policy refuses `*.supabase.co`, `api.supabase.com`, `*.pooler.supabase.com`, `*.vercel.app`, `deno.land`, `esm.sh`. Until they're allowed, workers build and unit-test but nobody can deploy to staging, run the backend (Deno) test suite, or run the isolation suite. **Also needed once that's open:** a Supabase access token (`sbp_…`) scoped to staging. Cost of waiting: PRs pile up in "built, awaiting QA"; nothing merges.
2. **Staging Twilio subaccount — unknown.** Default taken: C1's Twilio checks are deferred; C2 (the bridge) is queued behind this item. Free to change until C1 is ready for QA (~2–3 days).
3. **Outlook + inbox test accounts — unknown.** Needed for the G-C and G-B observations. Default taken: I will seed staging data myself and tell you exactly which inbox to check; if none is connected to a staging workspace, G-C's merge waits. Free to change until G-C is ready for QA (~1–2 days).
4. **GitHub token in chat.** Works; please revoke it when the program ends (or sooner and hand me a new one another way).
5. Product defaults from the plan (no action unless you disagree): purge crons stay OFF until outbound summaries exist, then 30 days · "call me, then connect" is the default with browser calling opt-in · Hebrew-first transcription with English alternative for Israeli workspaces. Reversal is free until the corresponding PR merges (C1 for calling defaults, E-S1b for retention).

## Units
| Unit | Tier | Status | Notes |
|---|---|---|---|
| P0 harness | 2 | building | branch `infra/p0-harness` |
| G-C automation-executor safety | 1 | building | branch `unit/g-c-executor-safety` |
| L1 lead data fixes | 2 | building | branch `unit/l1-lead-data-fixes` |
| E-S1a aiGateway | 2 | queued | same worker as L1, next |
| C1 calling safety | 1 | queued | after G-C (one Tier 1 at a time) |
| Q1 follow-up rule | 1 | queued | after C1 |
| G-A classify-inbound | 2 | queued | needs Q1 merged (shares queueQueries) |
| G-B sync dedupe | 1 | queued | needs Q1 merged |
| Q2 queue card | 3 | queued | needs Q1 merged |
| E-S1b capture + reply context | 2 | queued | needs E-S1a + G-B merged |
| C2 bridge calling | 1 | queued | needs C1 merged + Twilio staging |
| L3 meetings pipeline | 1 | queued | needs C2/G-B done (owns QueueCard, syncEngine) |
| L2 one-column lead page | 3 | queued | needs L1 merged |
| C3 call cards | 3 | queued | needs C2 merged |
| G-M merge engines | 1 | queued | needs G-C + Q1 merged |
| E-S2 five parts (flagged) | 1 | queued | needs G-A, G-B, L3, E-S1b merged |
| E-S3 outcomes | 2 | queued | needs E-S2 soak |
| Retention crons on | — | queued | needs E-S1b outbound summaries |

## Facts that differ from the plan (found on day 1)
- `vitest.integration.config.ts` and `STAGING_TEST_PLAN.md` already exist on main (the plan said they didn't). The harness worker extends them instead of creating them.
- The typecheck command is `npx tsc -b --noEmit` (plain `tsc --noEmit` passes vacuously).
- Staging's `dispatch-automation-executor` cron is intentionally OFF (a consented test lead would get real sends); the G-C tick will be triggered by hand.
- The 72h purge on staging was deliberately widened to 30 days earlier this year.

## Confidence
~55% today (plan's number). Two facts that raise it: (1) the harness PR merged and the network policy open so a QA gate actually runs against staging (→ ~78%); (2) G-C completing a full staging cycle with your observed single-signature email (→ ≥95% per unit after that).
