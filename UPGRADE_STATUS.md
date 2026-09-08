# DrivePilot master upgrade — checkpoint

Updated: 2026-09-09 00:40 (Israel time) · origin/main `5f818be7` · **6 units merged, 4 PRs open. Two production problems found today that nobody knew about.**

## OBSERVE — things only you can see or hear

**1. G-C — the automatic sender (PR #138).** Everything I could prove without you is proven: emergency stop returns `paused, sent 0` in 1 second writing nothing; a full tick finishes in 5 seconds where it used to sleep up to 90 inside a 55-second timeout; the "why didn't this send?" ledger walks the pipeline forward one honest reason at a time. **What still needs you is only the email itself** — one email in a real inbox with exactly one signature, one footer, a working unsubscribe link and the `List-Unsubscribe` header. Blocked on DECIDE 1.

**2. C1 — calling (PR #145).** Once a staging Twilio subaccount exists: answer an outbound call from a second phone and **hear the recording notice yourself** — the rep should hear only ringing. Codex caught that the first fix played the notice to the rep instead of the person being recorded.

**3. Q1 — the follow-up rule (PR #146, new today — everything else about it is finished).** Three things a person has to look at, all in the app: send a real email and confirm the lead **leaves** the Queue instead of reappearing at the bottom of "Follow up"; on a lead showing a follow-up prompt, confirm the automation card reads "Automation: Off / Enable" and **not** "Resume Anyway"; and confirm the "Follow up anytime — auto-send paused until the 12th" card's own Follow up button still sends.

**4. L2 — the new lead page (#144, merged).** A 20-step phone walkthrough is on the PR. Worth 15 minutes on a 390px screen when convenient; not blocking anything.

## PRODUCTION — do in Lovable, in this order (batched)

**Batch 1 is done.** You applied both items earlier today and I verified them against the live database: the Queue's intent RPC is the new version, and `gmail_connections.bulk_sync_cursor` exists. **The Gmail sync outage is confirmed dead** — `gmail-bulk-sync` errored 138 times in the two days before the fix and every single run since 19:40 has succeeded.

Nothing to do right now. Batch 2 will follow when Q1 and the units behind it land. Standing rule: **never tell Lovable to apply `20260908000000_codify_cron_jobs_staging.sql`** — it is staging-only.

## DECIDE — what I need from you

**1. [BLOCKING G-C and E-S1a] The staging AI key is the wrong value.** The rename worked — Supabase staging now shows `LOVABLE_API_KEY`, the exact name the code reads. But the AI service rejects the value with a 401: "I don't recognise this key." Open your **production** project in Lovable → backend → secrets, copy the value of `LOVABLE_API_KEY` there, and paste that exact value into staging, replacing what's there. My read is that the current value is a Lovable *account* API key (for the editor), which is a different service from the AI gateway despite the shared name. Still also needed for the send test: one connected mailbox on staging, and an address you can actually read to replace the test lead's fake `ed@spruce-test.com`.

**2. [NEW — the most important thing on this page] The 72-hour purge has never run in production.** CLAUDE.md and the public product commitment say raw message bodies auto-purge within 72 hours (inbound waits for an AI summary, 7-day hard cap). The code that does this is correct. **Nothing calls it.** There is no `message-cleanup` cron and no `expire_old_messages` cron among the 17 scheduled jobs. Live counts:
- **4,896 email bodies** older than 7 days still stored, oldest dated 2012 (historical mail pulled in by sync).
- **5,253 message snippets** older than 7 days still stored.
- 0 of the WhatsApp/SMS bodies are overdue — that path is clean.

Nothing is leaking and no customer is harmed, but the commitment is not being met and hasn't been. This is your call, not mine, and it has a real trade-off: turning the purge on before outbound summaries exist (unit E-S1b) destroys the context the AI uses to write follow-ups. **The default I'm holding:** leave it off until E-S1b ships, then switch it on at 30 days — and in the meantime, either soften the wording of the commitment or tell me to schedule the job now and accept the context loss. If you want it on today, say so and I'll queue it as its own unit with a staging proof first.

**3. [NEW] One in five inbound messages was never classified, and the classifier times out a quarter of the time.** 407 inbound messages have no AI label at all — 403 of them older than a week — going back to 2025. Separately, `classify-inbound` runs every minute and **times out at 55 seconds on 88 of 360 runs** (24%). New mail is keeping up, so the 407 look like a stuck historical set the job retries and chokes on. Consequence: those messages can never be hidden by the Queue's bounce/out-of-office filter, and their bodies sit unpurged to the hard cap. **Default I'm holding:** a small unit after Q1 that makes the job skip what it has already failed on and process a bounded batch, plus a one-off backfill for the 407. Free to overturn.

**4. [NEW] Should a lead nobody has touched in a year be allowed to send itself an email?** Q1 was going to include a scheduled job giving Outlook the periodic re-check it has never had — Gmail gets one, Outlook doesn't, which is why an Outlook rep's unanswered mail never comes back as a follow-up. I built it and then **threw it away before it merged**, because the reviewer drove the real code and found it would have quietly re-armed the automatic sender on dormant leads: contacts silent for a year would have received a machine-written "re-engagement" email, oldest-silent first, with no rep involved. It also had a starvation bug that would have made it report success while doing nothing useful.

Rebuilding it properly hinges on one question that is yours, not mine: **when a lead has been quiet for a very long time, should the system be allowed to wake it up on its own, or should it only ever put a card in front of a human?** My default: **only a card.** That makes the rebuild much smaller and removes the whole class of risk by construction. Say the word if you want the automatic version and I'll build it with an explicit age limit instead.

**5. Staging Twilio subaccount — still unknown.** Default: C1's Twilio checks deferred, C2 queued behind it. Free to change until C1 reaches QA.

**6. Settled defaults you can still overturn:** uploaded-notes risks expire at the next re-analysis (L1) · WhatsApp auto-replies stay OFF behind a switch (E-S1a) · warm follow-ups obey the "require a postal address" setting like cold email does (G-C — check `COLD_REQUIRE_POSTAL_ADDRESS` in production before redeploying) · follow-up wait is 3 days on fast motion, 5 on nurture, calendar days (Q1) · "call me then connect" default · Hebrew-first transcription.

**7. GitHub token is in the chat history — revoke when the program ends.**

## Units

| Unit | Tier | Status | PR / commit |
|---|---|---|---|
| P0 harness | 2 | **merged** — staging gate passed, 3 Codex findings fixed | [#137](https://github.com/sbenchmuel-sys/leadrocketai/pull/137) |
| Staging ops job | 3 | **merged** — how every staging gate runs; now also posts the Deno suite's output to the PR | [#141](https://github.com/sbenchmuel-sys/leadrocketai/pull/141), [#142](https://github.com/sbenchmuel-sys/leadrocketai/pull/142), [#147](https://github.com/sbenchmuel-sys/leadrocketai/pull/147) |
| L1 lead data fixes | 2 | **merged** — staging gate passed | [#139](https://github.com/sbenchmuel-sys/leadrocketai/pull/139) |
| G-A Queue truth | 2 | **merged** — applied to production and verified live | [#143](https://github.com/sbenchmuel-sys/leadrocketai/pull/143) |
| L2 one-column lead page | 3 | **merged** — QA caught a wrong-customer delete race before it shipped | [#144](https://github.com/sbenchmuel-sys/leadrocketai/pull/144) |
| G-C executor safety | 1 | PR open · Codex green · QA SHIP WITH NOTES · kill switch, stagger cap and skip ledger **proven on staging** · only the email-content observation left | [#138](https://github.com/sbenchmuel-sys/leadrocketai/pull/138) @ `ac4e3a76` |
| E-S1a aiGateway | 2 | PR open · Codex green · QA SHIP WITH NOTES · all 16 rerouted functions boot on staging · holding the merge until one real AI call can be proven | [#140](https://github.com/sbenchmuel-sys/leadrocketai/pull/140) @ `3bf46b93` |
| C1 calling safety | 1 | PR open · Codex green · QA HOLD→fixed · blocked on a staging Twilio subaccount | [#145](https://github.com/sbenchmuel-sys/leadrocketai/pull/145) @ `2778674e` |
| **Q1 follow-up rule** | 1 | **new** · QA HOLD → HOLD → SHIP → HOLD → **cleared after splitting one piece out** · Codex's three findings all addressed · **staging gate green, Deno suite green in CI** · waiting only on your three observations | [#146](https://github.com/sbenchmuel-sys/leadrocketai/pull/146) @ `648737b5` |
| Q1b Outlook second look | 1 | **not started — needs DECIDE 4 first** | — |
| G-B / Q2 / E-S1b / C2 / L3 / C3 / G-M / E-S2 / E-S3 / retention | | queued — each one needs Q1, G-C, C1 or E-S1a to merge first; they share files with the open PRs, so starting one now would only create conflicts | |

## Things that were quietly broken in production, found by this program

1. **The 72-hour purge has never run.** 4,896 email bodies and 5,253 snippets past the deadline, oldest from 2012. The code is right; nothing schedules it. (DECIDE 2.)
2. **Every bounce and out-of-office reply since the spring sat in reps' queues as a "reply needed" card.** The AI's labels and the Queue's hide-list had no words in common. (G-A — fixed, applied to production, verified live. It now costs nothing: a bounce no longer triggers an AI call at all.)
3. **Gmail bulk sync had been failing for 2.5 months** on a missing database column. (Fixed, applied, and confirmed healthy — every run since 19:40 today has succeeded.)
4. **One in five inbound messages was never classified, and the classifier times out on a quarter of its runs.** (DECIDE 3.)
5. **Warm leads vanished from the Queue for six weeks.** If a customer replied once and then went quiet after your next email, there was no follow-up rule for them at all. Outlook reps' sent mail never came back as a follow-up either, because Outlook has no automatic sync. (Q1 — fixed.)
6. **Meeting transcripts are never analysed.** `transcript-poller` calls the analyser with no auth header, so the gateway rejects it every time. (Will be fixed inside L3.)
7. **Queued lead re-analysis was failing the same way.** (L1 — fixed and proven on staging.)
8. **Six AI call sites were pointed at a wrong address** and silently failing: WhatsApp classification, reply suggestions, style extraction, the audio transcription path. (E-S1a — fixed; the WhatsApp one is deliberately left switched off until its consent logic is reviewed, because un-breaking it would have started auto-texting unknown numbers.)
9. **Staging had 12 cron jobs with the API key written into each command.** Now 17, matching production, all reading from the encrypted vault. (Harness.)

## What the review layers are catching

Every unit goes through four gates: the worker builds it → an independent reviewer reads every line → Codex reviews the PR → the staging job runs it against the real database.

Q1 is the clearest example yet. The reviewer held it **twice**. First: every email a rep sent would have bounced straight back into the Queue seconds later as a "follow up" card — the Queue would never have emptied. Second, and far worse: pressing "Resume" on a lead would have armed a **real automated email to a real customer**, two days later, from the wrong template, that nobody asked for. When that was fixed, the reviewer found the identical bug surviving in the "Enable Automation" button next to it. All three are closed and pinned by tests that genuinely fail without them — the reviewer proved that by putting the old code back and watching exactly three tests break.

Round four caught the biggest one of the whole program so far: a scheduled job I wrote would have started sending automated emails to customers who had heard nothing for over a year. Its own safety test passed — because the test read the file's text for the word "send" rather than watching what the code actually wrote to the database. I threw the job away rather than patch it. That is what the four gates are for.

Running total of real defects caught before merge: a wrong-customer delete race on the lead page, an automatic WhatsApp reply that would have texted strangers, three ways a genuine customer question could have been buried by the new Queue filters, a misconfigured sender that would have re-spent AI credits every 15 minutes, and Q1's three. **None reached production.**

## Confidence

**~85%.** The loop is real and four units have gone through it end to end. Two facts would take it to ≥95%: a working AI key on staging, so G-C's send test runs and you observe one real email; and one more production batch applied cleanly with the scheduled jobs quiet for an hour afterwards. The two new production findings don't lower my confidence in the program — the program is what found them — but DECIDE 2 is the first thing on this page that is a promise to customers rather than an engineering detail.
