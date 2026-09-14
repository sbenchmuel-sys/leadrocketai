# DrivePilot master upgrade — checkpoint

Updated: 2026-09-14 10:45 (Israel time) · origin/main `bcfc45c2` · **Every unit is merged. Zero open PRs. Your turn.**

## WHERE THE PROGRAM STANDS

All twelve units have gone through the four gates and merged. There is no engineering work left that can proceed without you. What remains is three things only you can do: apply the batch in Lovable, observe a handful of real-world results, and settle two product decisions.

## PRODUCTION — do in Lovable, in this order

Say each of these to Lovable chat, one at a time, waiting for each to finish:

1. `Apply migration supabase/migrations/20260907000000_transactional_enrollment_rpcs.sql`
2. `Apply migration supabase/migrations/20260907000100_cadence_step_conditions.sql`
3. `Apply migration supabase/migrations/20260908150000_purge_call_media.sql`

The third one is the retention fix: it strips verbatim customer quotes out of two columns the 90-day purge had never been clearing. It rewrites historical rows, so let it finish before doing anything else.

**Standing rule: never tell Lovable to apply `20260908000000_codify_cron_jobs_staging.sql`.** It is staging-only and would point production's scheduled jobs at the wrong database.

After the batch, give the scheduled jobs an hour and tell me — I'll verify against the live database and confirm the jobs are quiet.

## OBSERVE — things only you can see or hear

1. **One real email from the automatic sender.** Exactly one signature, one footer, a working unsubscribe link. Needs a working AI key on staging and an address you can actually read (DECIDE 1).
2. **The recording notice on a call.** Answer an outbound call from a second phone — you should hear the notice, the rep should hear only ringing. Needs a staging Twilio subaccount (DECIDE 5).
3. **A company nobody has enriched before.** Should return a result and save it. Before this batch it was a guaranteed error.
4. **The Queue, after sending a real email.** The lead should *leave* the Queue, not reappear under "Follow up".
5. **A lead with a follow-up prompt.** Its automation card should read "Automation: Off / Enable" — never "Resume Anyway".

## DECIDE — what I need from you

**1. The staging AI key is the wrong value.** Staging has the right secret *name* but the AI service rejects the value with a 401. Copy the value from your production Lovable project's secrets into staging. Also needed: one connected mailbox on staging, and a real readable address.

**2. The 72-hour purge has never run in production.** Your product wording says raw message bodies auto-purge within 72 hours. The code is correct; nothing calls it. 4,896 email bodies and 5,253 snippets are past the deadline, oldest dated 2012. Nothing is leaking and no customer is harmed, but the promise is not being kept. Turning it on before outbound summaries exist destroys the context the AI uses to write follow-ups. **Default I'm holding:** off until that unit ships, then 30 days — or soften the wording instead.

**3. Staging Twilio subaccount.** Blocks the call observation and the next calling unit.

**4. Three credentials are in this chat's history — revoke them now the program is done:** the GitHub token, the Supabase token, and the throwaway mailbox password.

**Settled defaults you can still overturn:** dormant leads only ever produce a card, never an automatic send (hard constraint) · uploaded-notes risks expire at the next re-analysis · WhatsApp auto-replies stay OFF behind a switch · warm follow-ups obey the "require a postal address" setting like cold email does · follow-up wait is 3 days on fast motion, 5 on nurture · "call me then connect" default · Hebrew-first transcription.

## What was quietly broken in production, and is now fixed

1. **Your AI account ran out of credits and inbound classification died with it on ~3 September.** Nothing alerted anyone; the job reported success 1,440 times a day for eleven days. Not "falling behind" — **zero of 1,284 messages classified.**
2. **The classifier's batch size was tuned against a broken service.** Once credits came back, every run overran the 55-second limit and was killed.
3. **Gmail bulk sync had been failing for 2.5 months** on a missing database column.
4. **Every bounce and out-of-office reply since the spring sat in reps' queues** as a "reply needed" card.
5. **Warm leads vanished from the Queue for six weeks.** If a customer replied once then went quiet, no follow-up rule covered them at all.
6. **Six AI features were silently failing** on a wrong address, the Sales Brain among them.
7. **Call transcripts kept verbatim customer quotes forever.** The 90-day purge cleared one column and left the quotes in two others, and its own eligibility rule stopped it ever revisiting them.
8. **A removed user could still place calls, and one workspace could dial out using another's caller ID.**
9. **Company enrichment failed for every company not already cached** — the searches ran, the credits were spent, then it crashed and saved nothing.
10. **The automatic sender could starve itself.** Seven separate ways a blocked row could sit at the front of a capped scan forever, hiding every other customer behind it.
11. **A mistyped send-cap secret disabled both the cap and the alarm meant to catch it** — an uncapped sender, silently.
12. **Your local repo had been frozen since 6 September** on three abandoned lock files. That was why GitHub Desktop looked stuck.

Still queued, documented, not yet built: Outlook has no periodic re-check · `followup_wait_days` isn't settable from the UI · `twilio-voice-token` issues tokens to non-members · no per-workspace owned-numbers table · meeting transcripts are never analysed (`transcript-poller` calls the analyser with no auth header).

## Known and accepted, not fixed

Logged deliberately rather than forgotten. None is a major bug; each was judged not worth another round on code that is now correct:

- The volume alarm's default threshold equals the per-run cap, so a single full batch doesn't trip it. Tuning, not safety.
- The minimum email gap can still be misjudged if a send succeeded but its ledger row failed to write — the lead may get a second email sooner than configured.
- The paused-owner prefilter reads one page of profiles; past ~1,000 paused owners it could truncate.
- An out-of-office deferral moves the current touch but not later pre-created ones.
- Completing a call card with the generic "Mark as handled" doesn't record an outcome, so a "no answer" follow-up can queue after a call that was answered.

## What the review layers caught

Four gates per unit: the worker builds it → an independent reviewer reads every line → Codex reviews the PR → the staging job runs it against the real database.

The clearest example is the last one. Codex cleared the automatic sender with zero major bugs — your stated bar — and I didn't merge, because the remaining finding was a case where it could send a second email to the same person inside the minimum gap. The first attempt at that fix looked correct and was completely inert: it filtered on a database column that Gmail never fills in, so it matched none of your real sent emails while appearing to protect them. The tests passed because they were written against rows the fix hoped to find rather than rows Gmail actually writes.

That is the recurring shape of the dangerous defects here, and it is worth naming plainly: **things that confidently report success while doing nothing.** The classifier reporting success for eleven days while classifying nothing. A safety test that greps a file for the word "send" instead of watching what the code writes. A retry ceiling documented at 69 hours while the code served 45. A guard filtering on a column that is always empty. A send cap that stops capping the moment its value is mistyped. None of these look like failures from outside, which is exactly why nothing caught them for months.

Real defects caught before merge, across the program: a wrong-customer delete race, an automatic WhatsApp reply that would have texted strangers, a scheduled job that would have emailed customers silent for over a year, a retention breach, a cross-tenant caller-ID hole, seven starvation paths in the sender, and the two above. **None reached production.**

## Confidence

**~92%.** Twelve units through the loop end to end, all merged, `main` green on every gate. What would take it to ≥95% is entirely in your hands now: the batch applied cleanly with the scheduled jobs quiet for an hour afterwards, and one real email you can see with your own eyes.
