# DrivePilot master upgrade — checkpoint

Updated: 2026-09-14 09:20 (Israel time) · origin/main `22ca26f8` · **10 units merged. Two PRs fixed and ready to push — blocked only on your computer being reachable.**

> **Shai's decisions so far:** DECIDE 3 (classifier resilience/backfill) — **approved, shipped.** DECIDE 4 (dormant-lead re-engagement) — **decided: card for a human only; no automatic sending, ever.** DECIDE 1 (staging AI key), DECIDE 2 (72-hour purge), DECIDE 5 (staging Twilio subaccount) — **deferred.**

## RIGHT NOW — what's blocked and on what

**The only thing stopping me is that your computer went offline around 05:45 UTC.** That's my only route to push code to GitHub; the cloud can't reach it directly. Both remaining PRs are finished, tested and committed on my side, waiting to go out. There is nothing for you to do except have the machine on with the Claude desktop app running. A retry is scheduled automatically.

## OBSERVE — things only you can see or hear

**1. G-C — the automatic sender (PR #138).** Everything provable without you is proven. **What still needs you is the email itself** — one email in a real inbox with exactly one signature, one footer, a working unsubscribe link and the `List-Unsubscribe` header. Blocked on DECIDE 1 (staging AI key) and on giving me an address you can actually read.

**2. C1 — calling (merged).** Still worth doing once a staging Twilio subaccount exists: answer an outbound call from a second phone and **hear the recording notice yourself** — the rep should hear only ringing.

**3. Q1 — the follow-up rule (merged).** Three things to look at in the app when convenient: send a real email and confirm the lead **leaves** the Queue instead of reappearing under "Follow up"; confirm a lead showing a follow-up prompt reads "Automation: Off / Enable" and **not** "Resume Anyway"; and confirm the "Follow up anytime — auto-send paused until the 12th" card's own Follow up button still sends.

**4. PR #136 — enrichment.** Once merged and deployed: look up a company **nobody in the workspace has looked up before**. Before this fix that was a guaranteed error with nothing saved.

## PRODUCTION — do in Lovable, in this order (batched)

**Batch 1 is done and verified live.** The Queue's intent RPC is the new version and `gmail_connections.bulk_sync_cursor` exists. The Gmail sync outage is confirmed dead.

**Batch 2 is now pending** — four merged units are waiting to be applied to production. I'll give you the exact list when #136 and #138 land, so it's one session rather than four. Standing rule: **never tell Lovable to apply `20260908000000_codify_cron_jobs_staging.sql`** — it is staging-only.

## DECIDE — what I need from you

**1. [DEFERRED — blocking G-C's send test] The staging AI key is the wrong value.** Supabase staging shows `LOVABLE_API_KEY` under the right name, but the AI service rejects the value with a 401. Copy the value from your **production** Lovable project's secrets into staging. Also still needed: one connected mailbox on staging, and a real readable address to replace the test lead's fake one.

**2. [DEFERRED — the most important thing on this page] The 72-hour purge has never run in production.** The product commitment says raw message bodies auto-purge within 72 hours. The code is correct; **nothing calls it.** 4,896 email bodies and 5,253 snippets are past the deadline, oldest dated 2012. Nothing is leaking and no customer is harmed, but the commitment is not being met. Trade-off: turning it on before outbound summaries exist (unit E-S1b) destroys the context the AI uses to write follow-ups. **Default I'm holding:** off until E-S1b ships, then 30 days — or soften the wording of the commitment.

**3. [DONE] Classifier resilience** — shipped as Q1c.

**4. [DECIDED] Dormant-lead re-engagement — card only, never automatic.** Hard constraint for Q1b and anything that touches dormant leads.

**5. Staging Twilio subaccount — still unknown.** C1's call checks and C2 wait on it.

**6. Settled defaults you can still overturn:** uploaded-notes risks expire at the next re-analysis · WhatsApp auto-replies stay OFF behind a switch · warm follow-ups obey the "require a postal address" setting like cold email does (check `COLD_REQUIRE_POSTAL_ADDRESS` in production before redeploying) · follow-up wait is 3 days on fast motion, 5 on nurture, calendar days · "call me then connect" default · Hebrew-first transcription.

**7. Three credentials are in the chat history — revoke when the program ends:** the GitHub token, the Supabase token, and the throwaway mailbox password.

## Units

| Unit | Status |
|---|---|
| P0 harness · Staging ops job · L1 · G-A · L2 | **merged** |
| **Q1c classifier resilience** | **merged** (`9d06addd`) |
| **E-S1a shared AI gateway** | **merged** (`8eb5d188`) |
| **C1 calling safety** | **merged** (`0a19a82a`) — Twilio observation still outstanding |
| **Q1 follow-up rule** | **merged** (`22ca26f8`) |
| **G-C executor safety (#138)** | fixed and green · **0 major bugs** · one fail-open in the minimum-gap check closed after two attempts · **waiting to push** |
| **Outreach sprint 3 (#136)** | fixed and green · enrichment break and the launch-path scheduling hole both closed · **waiting to push** |
| Q1b Outlook second look | cleared to start — card-only, no auto-send |
| G-B / Q2 / E-S1b / C2 / L3 / C3 / G-M / E-S2 / E-S3 / retention | queued behind the two open PRs |

## Things that were quietly broken in production, found by this program

1. **Your AI account ran out of credits, and inbound classification died with it on ~3 September.** Nothing alerted anyone; the job reported success 1,440 times a day for eleven days. Not "falling behind" — **zero of 1,284 messages classified.** (Fixed: credits restored, Q1c stops it recurring.)
2. **The classifier's batch size was tuned against a broken service.** Once the service came back, every run overran the 55-second limit and was killed. Only restoring credits and watching revealed it. (Q1c.)
3. **The 72-hour purge has never run.** (DECIDE 2 — deferred.)
4. **Every bounce and out-of-office reply since the spring sat in reps' queues as a "reply needed" card.** (G-A — fixed and verified live.)
5. **Gmail bulk sync had been failing for 2.5 months** on a missing database column. (Fixed and confirmed healthy.)
6. **Call transcripts kept verbatim customer quotes forever.** The 90-day purge cleared one column and left the quotes sitting in two others, and its own eligibility rule stopped it ever revisiting them. (C1 — fixed.)
7. **A removed user could still place calls, and one workspace could dial out using another's caller ID.** (C1 — fixed.)
8. **Meeting transcripts are never analysed.** `transcript-poller` calls the analyser with no auth header. (Queued in L3.)
9. **Warm leads vanished from the Queue for six weeks.** (Q1 — fixed.)
10. **Six AI features were silently failing** on a wrong address, including the Sales Brain. (E-S1a — fixed.)
11. **Company enrichment failed for every company not already cached** — the searches ran, the credits were spent, then it crashed and saved nothing. Only cached lookups worked, which is why nobody noticed. (#136 — fixed, pending push.)
12. **Your local repo had been stuck since 6 September** on three abandoned lock files. That was why GitHub Desktop looked frozen. (Cleared: locks removed, 15 stale worktrees pruned, 83 dead branches deleted.)

## What the review layers are catching

Every unit goes through four gates: the worker builds it → an independent reviewer reads every line → Codex reviews the PR → the staging job runs it against the real database.

The clearest recent example is the automatic sender. Codex came back with **zero major bugs** — your stated bar — and I didn't merge, because the one remaining finding was a case where it could send a **second email to the same person inside the minimum gap**. The first attempt at that fix looked correct and was completely inert: it filtered on a database column that Gmail never fills in, so it matched none of your real sent emails while appearing to protect them. The tests passed because they were written against rows the fix hoped to find rather than rows Gmail actually writes. I caught it by reading the sending code instead of trusting the fix.

That is the recurring shape of the dangerous defects here, and it is worth naming: **things that confidently report success while doing nothing.** The classifier reporting success for eleven days while classifying nothing. A safety test that greps a file for the word "send" instead of watching what the code writes. A retry ceiling documented at 69 hours while the code served 45. A guard filtering on a column that is always empty. None of these look like failures from outside.

Running total of real defects caught before merge: a wrong-customer delete race, an automatic WhatsApp reply that would have texted strangers, a scheduled job that would have emailed customers silent for over a year, a retention breach, a cross-tenant caller-ID hole, and the two above. **None reached production.**

## Confidence

**~90%.** Ten units through the loop end to end, four of them merged in the last day with rebase, type-check, build and full test suite between each. What would take it to ≥95%: a working AI key on staging so G-C's send test runs and you observe one real email, and one production batch applied cleanly with the scheduled jobs quiet for an hour afterwards.
