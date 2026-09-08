# DrivePilot master upgrade — checkpoint

Updated: 2026-09-08 21:30 (Israel time) · origin/main `d5137e96` · **4 units merged, 3 PRs waiting on you.**

## OBSERVE — things only you can see or hear

**1. G-C — the automatic sender (PR #138). Partly done already.** I proved on staging today, without needing you:
- Emergency stop ON → the executor returns `paused, sent 0` in **1 second** and writes nothing at all (it returns before reserving anything).
- Emergency stop OFF → a full tick finishes in **5 seconds**. It used to sleep up to 90 seconds inside a 55-second timeout, which is why cold sends were being starved.
- The new "why didn't this send?" ledger works, and it walked the pipeline forward one honest reason at a time: *"Workspace timezone not configured"* → I fixed that on staging → *"Outside send window 09:00–17:00 Asia/Jerusalem"* (correct — it was 9pm). Before this unit, all of that was silence.
- The test lead's claim was not burned: he stays eligible for the next tick.

**What still needs you** is only the email itself — that one email in a real inbox with exactly one signature and one footer, a working unsubscribe link, and the `List-Unsubscribe` header. That needs four things on staging: `LOVABLE_API_KEY`, one connected mailbox, a real address for the test lead, and a tick inside 09:00–17:00. See DECIDE 1.

**2. C1 — calling (PR #145).** Two things: read me the Twilio console's Voice Request URL (DECIDE 2), and later, once a staging Twilio subaccount exists, **answer an outbound call from a second phone and hear the recording notice yourself** — the rep should hear only ringing. Codex caught that my first fix played the notice to the rep instead of the person being recorded.

**3. L2 — the new lead page (#144), already merged.** A 20-step phone walkthrough is on the PR. Worth 15 minutes on a 390px screen when convenient; it is not blocking anything.

## PRODUCTION — do in Lovable, in this order (batched)
Two units are merged. Nothing needs doing yet — **wait until I say the batch is ready**, because more is coming and the order matters. For your information, what has accumulated:
1. **P0 harness (#137)** — no production migration. Its migration is staging-only: **never tell Lovable to apply `20260908000000_codify_cron_jobs_staging.sql`.** Functions that changed (pure code moves): `ai_task`, `automation-executor`.
2. **L1 lead data fixes (#139)** — no migration. Functions: `recompute-lead-intelligence`, `sms-webhook`, `intelligence-queue-drain`, plus anything bundling `_shared/timelineProjector.ts` (`call-analyze`, `twilio-voice-webhook`, `meeting-transcript-analyze`, `conversation-analyze`).

## DECIDE — what I need from you
1. **[BLOCKING G-C's send test] Four things on staging, one sitting.** (a) `LOVABLE_API_KEY` in Supabase → drivepilot-staging → Edge Functions → Secrets — without it no email can be generated at all. (b) Connect one mailbox: log into `drivepilot-staging.vercel.app` as `repa@drivepilot-test.com` and connect a Gmail or Outlook account through Settings — a throwaway is fine. (c) Give me an address you can actually read, to replace the test lead's fake `ed@spruce-test.com`. (d) The tick has to land inside 09:00–17:00 Israel time, which I'll handle. Optional: `OPENAI_API_KEY` for embeddings. I already fixed the missing workspace timezone myself.
2. **Retention: your docs and your database disagree.** CLAUDE.md says raw message bodies are kept until the AI has written a summary, then purged at 72h. The repo's newest migration says a flat 30-day cap with no AI gate — but the **live staging database** has the gated version and the hourly cleanup job is running. So three sources tell three stories. Nothing is at risk (all three keep data longer than promised, never less), but before the program turns retention on in production I need one answer. Default I'm holding: purge stays off until outbound summaries exist, then 30 days.
3. **Staging Twilio subaccount — still unknown.** Default: C1's Twilio checks deferred, C2 queued behind it. Free to change until C1 reaches QA.
4. **A real inbox + Outlook account on staging** — needed for observation 1 above and later for G-B. Default: I seed the data and tell you exactly which inbox to open.
5. **Settled defaults you can still overturn:** uploaded-notes risks now expire at the next re-analysis (L1) · WhatsApp auto-replies stay OFF behind a switch (E-S1a) · warm follow-ups now obey the "require a postal address" setting like cold email does (G-C — check `COLD_REQUIRE_POSTAL_ADDRESS` in production before redeploying) · purge crons off, "call me then connect" default, Hebrew-first transcription.
6. GitHub token is in the chat history — revoke when the program ends.

## Units
| Unit | Tier | Status | PR / commit |
|---|---|---|---|
| P0 harness | 2 | **merged** — staging gate passed, 3 Codex findings fixed | [#137](https://github.com/sbenchmuel-sys/leadrocketai/pull/137) |
| Staging ops job | 3 | **merged** — how every staging gate now runs | [#141](https://github.com/sbenchmuel-sys/leadrocketai/pull/141), [#142](https://github.com/sbenchmuel-sys/leadrocketai/pull/142) |
| L1 lead data fixes | 2 | **merged** — staging gate passed (double-enqueue → one row, drain ok, intelligence written) | [#139](https://github.com/sbenchmuel-sys/leadrocketai/pull/139) |
| G-C executor safety | 1 | PR open · Codex green · QA SHIP WITH NOTES · **kill switch, stagger cap and skip ledger PROVEN on staging** · only the email-content observation left | [#138](https://github.com/sbenchmuel-sys/leadrocketai/pull/138) @ `4bf28459` |
| E-S1a aiGateway | 2 | PR open · Codex green · QA SHIP WITH NOTES · **all 16 rerouted functions boot on staging**; holding the merge until one real AI call can be proven | [#140](https://github.com/sbenchmuel-sys/leadrocketai/pull/140) @ `70478bf7` |
| G-A Queue truth | 2 | **merged** — staging proved detectors short-circuit, a truncated OOO with a late question is not hidden while the control still is | [#143](https://github.com/sbenchmuel-sys/leadrocketai/pull/143) |
| L2 one-column lead page | 3 | **merged** — QA caught a wrong-customer delete race before it shipped | [#144](https://github.com/sbenchmuel-sys/leadrocketai/pull/144) |
| C1 calling safety | 1 | PR open · Codex green · QA HOLD→fixed · blocked on the Twilio console URL and a staging Twilio subaccount | [#145](https://github.com/sbenchmuel-sys/leadrocketai/pull/145) @ `9600cf05` |
| Q1 → G-B/Q2 → E-S1b/C2 → L3 → C3 → G-M → E-S2 → E-S3 → retention | | queued — every one of them depends on G-C or C1 merging, so the program is now genuinely gated on the two items above | |

## Things that were quietly broken in production, found by this program
1. **Every bounce and out-of-office reply since the spring has sat in reps' queues as a "reply needed" card.** The AI's labels and the Queue's hide-list had no words in common, so nothing could ever be hidden. (G-A — fixed, and it now costs nothing: a bounce no longer triggers an AI call at all.)
2. **Meeting transcripts are never analysed.** `transcript-poller` calls the analyser with no auth header, so the gateway rejects it every time — recorded meetings get a transcript and no summary. (Will be fixed inside L3.)
3. **Queued lead re-analysis was failing the same way** — same missing header, so every recompute triggered by a text, call or meeting was rejected. (L1 — fixed and proven on staging.)
4. **Six AI call sites were pointed at a wrong address** and silently failing: WhatsApp classification, reply suggestions, style extraction, the audio transcription path. (E-S1a — fixed; the WhatsApp one is deliberately left switched off until its consent logic is reviewed, because un-breaking it would have started auto-texting unknown numbers.)
5. **Staging had 12 cron jobs with the API key written into each command.** Now 17, matching production, all reading from the encrypted vault, with only the automatic sender switched off. (Harness.)

## What the review layers are catching
Every unit goes through four gates: the worker builds it → an independent reviewer reads every line → Codex reviews the PR → the staging job runs it against the real database. Real defects caught before merge so far: a wrong-customer delete race on the lead page, an automatic WhatsApp reply that would have woken up and texted strangers, three separate ways a genuine customer question could have been buried by the new Queue filters, and a misconfigured sender that would have re-spent AI credits every 15 minutes. None reached production.

## Confidence
**~85%.** The whole loop is real now — build, review, Codex, staging, merge — and two units have gone through it end to end. The two facts that would take it to ≥95%: the AI key on staging so G-C's send test runs and you observe one real email, and one production batch applied cleanly with `cron_run_log` quiet for an hour afterwards.
