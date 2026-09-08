# DrivePilot master upgrade — checkpoint

Updated: 2026-09-08 09:40 (Israel time) · origin/main `f75a3ce9` · four PRs open, waiting for Codex + staging.

## OBSERVE — things only you can see or hear (each unblocks one PR)
_Nothing ready to observe yet — every observation needs the branch deployed to staging first, and staging is still unreachable (see DECIDE 1)._ Coming first: **G-C** — one executor tick under 55s, one email in a real inbox with exactly one signature and one footer, kill switch sends zero, review-mode Send still works with the switch on.

## PRODUCTION — do in Lovable, in this order (batched; staging never waits for this)
_Nothing merged yet._

## DECIDE — what I need from you, and defaults I took
1. ~~GitHub token read-only~~ — fixed 08 Sep; branches pushed, PRs #137–#140 open.
2. **[BLOCKING every QA gate] Network access for staging.** Allow `*.supabase.co`, `api.supabase.com`, `*.pooler.supabase.com`, `*.vercel.app`, `deno.land`, `esm.sh` in the Claude app's network settings, then give me a Supabase access token (`sbp_…`). Until then: built and code-reviewed, but nothing can be deployed to staging, so nothing merges.
3. **Staging Twilio subaccount — unknown.** Default: C1's Twilio checks deferred; C2 waits. Free to change until C1 reaches QA.
4. **Outlook + real inbox test accounts — unknown.** Needed for the G-C and G-B observations. Default: I seed staging and tell you which inbox to check.
5. **Uploaded-notes risks now expire (L1).** Fixing "risks are immortal" means risks that came only from an uploaded meeting recap disappear at the next automatic re-analysis (after the next reply/call). Default taken: accept — the AI re-derives risks from live evidence. If you want upload-derived risks to persist, say so before L1 merges and it becomes a small follow-up (keep uploads as their own evidence source). Cost of changing later: one more small PR.
6. **WhatsApp auto-replies stay OFF by default (E-S1a).** Fixing the wrong AI address would have silently woken up an automatic WhatsApp reply path that can text unknown numbers and email-enrolled leads. It's now behind `WHATSAPP_AUTO_REPLY_ENABLED=true`, unset everywhere. Default: keep it off until the consent logic is reviewed in G-M. Free to flip per environment at any time.
7. **Warm follow-ups now obey the "require a postal address" switch (G-C)** like cold email does. If `COLD_REQUIRE_POSTAL_ADDRESS=true` is set in production, workspaces with no mailing address stop getting automatic warm follow-ups (skipped and logged, not lost). Default: leave the switch as it is; I'll list it in the G-C production notes so you check it before redeploying.
8. Product defaults from the plan (unchanged): purge crons OFF until outbound summaries exist, then 30 days · "call me, then connect" default with browser opt-in · Hebrew-first + English alternative for Israeli workspaces.
9. GitHub token is in the chat history — revoke when the program ends.

## Units
| Unit | Tier | Status | Branch / commit | QA (code-only, provisional) |
|---|---|---|---|---|
| P0 harness | 2 | **PR open** [#137](https://github.com/sbenchmuel-sys/leadrocketai/pull/137) · awaiting Codex + staging QA | `infra/p0-harness` @ `eda1eb29` | SHIP WITH NOTES (notes fixed: 17-job staging cron, PR template, purity guard) |
| G-C executor safety | 1 | **PR open** [#138](https://github.com/sbenchmuel-sys/leadrocketai/pull/138) · awaiting Codex + staging QA + your observation | `unit/g-c-executor-safety` @ `38148a45` | SHIP WITH NOTES (note fixed: fail-closed checks moved before AI call) |
| L1 lead data fixes | 2 | **PR open** [#139](https://github.com/sbenchmuel-sys/leadrocketai/pull/139) · awaiting Codex + staging QA | `unit/l1-lead-data-fixes` @ `b51e63ba` | SHIP WITH NOTES (notes fixed: merge-seed, MeetingsTab index bug) |
| E-S1a aiGateway | 2 | **PR open** [#140](https://github.com/sbenchmuel-sys/leadrocketai/pull/140) · awaiting Codex + staging QA | `unit/e-s1a-ai-gateway` @ `fa5dd0cc` | HOLD → fixed → SHIP WITH NOTES (WhatsApp off-switch, 402 no-retry, 180s PDF timeout, eval import) |
| C1 calling safety | 1 | queued — starts when G-C merges (one Tier 1 at a time) | | |
| Q1 follow-up rule | 1 | queued — after C1 | | |
| G-A, G-B, Q2 | 2/1/3 | queued — need Q1 merged | | |
| E-S1b | 2 | queued — needs E-S1a + G-B merged | | |
| C2, L3, L2, C3, G-M, E-S2, E-S3, retention | | queued per the dependency graph | | |

What "code-only QA" means: a separate reviewer read every line, ran the type-check, build and the full unit suite (476 tests on the harness branch), and proved from the code that the four sender guardrails (out-of-office, opt-out, no duplicate sends, stop on reply) still fire. What it could NOT do: deploy to staging, run the backend (Deno) suite, or watch a real send. Those steps are written down per branch and run the moment staging opens.

## Facts that differ from the plan (found on day 1)
- `vitest.integration.config.ts` and `STAGING_TEST_PLAN.md` already existed on main; the harness extended them.
- Typecheck command is `npx tsc -b --noEmit`.
- Production runs 17 cron jobs, not 10; the staging cron file now mirrors all 17 with the executor and the campaign scheduler inactive.
- Staging's `dispatch-automation-executor` cron is intentionally OFF; the G-C tick will be triggered by hand.
- Six AI call sites were pointed at a wrong host and silently failing (WhatsApp classification, reply suggestions, style extraction, audio ASR path); E-S1a fixes the address.
- `promote-winning-interactions` (Sales Brain promotion) sends a non-chat body and has been failing on its own for a while — separate follow-up, not in this program's scope yet.

## Follow-ups queued (small, not blocking)
- `automation_logs` WhatsApp decision row says `auto_sent` even when the new switch blocked the send (cosmetic).
- `promote-winning-interactions` body shape (see above).
- Eval baseline (`coldTemplateEval.ts run`) still PENDING — needs `LOVABLE_API_KEY` + network.

## Confidence
~60% (up from 55%: four branches built and independently code-reviewed; two real safety issues caught before staging — the WhatsApp auto-reply wake-up and the fail-closed ordering). Two facts that raise it most: (1) network open + token writable → harness PR merged and the first staging QA gate actually runs (→ ~78%); (2) G-C completes a full staging cycle with your observed single-signature email (→ ≥95% per unit after that).
