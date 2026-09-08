# DrivePilot master upgrade — checkpoint

Updated: 2026-09-08 19:30 (Israel time) · origin/main `79eb4790` · **2 units merged, 5 PRs open, staging gates running for real.**

## OBSERVE — things only you can see or hear (each unblocks one PR)
Still nothing you can do yet — every observation needs the branch running on staging, and the AI key is missing (DECIDE 1). Two are queued and ready the moment it exists:

**1. G-C — the automatic sender (PR #138).** ~10 minutes.
   a. I trigger one send to the consented test lead "Eligible Ed"; you open that inbox and confirm the email has **exactly one signature and exactly one footer** (no second "reply unsubscribe" paragraph).
   b. Click the unsubscribe link in it — the confirmation page loads and the lead shows as unsubscribed.
   c. In Gmail, "Show original" → confirm `List-Unsubscribe` is in the headers.
   d. With the emergency stop switched on, open an Outreach card in review mode and press Send — it must still go (the kill switch must never block a rep pressing Send).

**2. L2 — the new lead page (PR #144).** ~15 minutes on your phone. A 20-step walkthrough is written and attached to the PR; the parts only you can judge are thumb reach and visual fit at 390px.

## PRODUCTION — do in Lovable, in this order (batched)
Two units are merged. Nothing needs doing yet — **wait until I say the batch is ready**, because more is coming and the order matters. For your information, what has accumulated:
1. **P0 harness (#137)** — no production migration. Its migration is staging-only: **never tell Lovable to apply `20260908000000_codify_cron_jobs_staging.sql`.** Functions that changed (pure code moves): `ai_task`, `automation-executor`.
2. **L1 lead data fixes (#139)** — no migration. Functions: `recompute-lead-intelligence`, `sms-webhook`, `intelligence-queue-drain`, plus anything bundling `_shared/timelineProjector.ts` (`call-analyze`, `twilio-voice-webhook`, `meeting-transcript-analyze`, `conversation-analyze`).

## DECIDE — what I need from you
1. **[BLOCKING — the only thing holding up your first observation] `LOVABLE_API_KEY` is not set on the staging project.** Supabase dashboard → *drivepilot-staging* → Edge Functions → Secrets → add `LOVABLE_API_KEY` (production's value is fine). Optional: `OPENAI_API_KEY` for embeddings. Everything else on staging now works — functions deploy, migrations apply, the database is reachable, the backend test suite runs on every PR.
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
| G-C executor safety | 1 | PR open · Codex green · code-QA re-gated SHIP WITH NOTES · **staging tick waits on the AI key**, then your observation | [#138](https://github.com/sbenchmuel-sys/leadrocketai/pull/138) @ `8f9191f1` |
| E-S1a aiGateway | 2 | PR open · Codex green · rebased onto merged main · staging checks wait on the AI key | [#140](https://github.com/sbenchmuel-sys/leadrocketai/pull/140) @ `ab10f777` |
| G-A Queue truth | 2 | PR open · **staging gate passed** · code-QA HOLD→fixed · 3 Codex P1s + 1 P2 fixed · awaiting Codex re-review | [#143](https://github.com/sbenchmuel-sys/leadrocketai/pull/143) @ `150f861d` |
| L2 one-column lead page | 3 | PR open · code-QA HOLD→fixed (wrong-lead delete race) · Codex P1+P2 fixed · awaiting re-review + your phone walkthrough | [#144](https://github.com/sbenchmuel-sys/leadrocketai/pull/144) @ `52c94b55` |
| C1 calling safety | 1 | queued — one Tier 1 at a time; starts when G-C merges | |
| Q1 → G-B/Q2 → E-S1b/C2 → L3 → C3 → G-M → E-S2 → E-S3 → retention | | queued per the dependency graph | |

## Things that were quietly broken in production, found by this program
1. **Every bounce and out-of-office reply since the spring has sat in reps' queues as a "reply needed" card.** The AI's labels and the Queue's hide-list had no words in common, so nothing could ever be hidden. (G-A — fixed, and it now costs nothing: a bounce no longer triggers an AI call at all.)
2. **Meeting transcripts are never analysed.** `transcript-poller` calls the analyser with no auth header, so the gateway rejects it every time — recorded meetings get a transcript and no summary. (Will be fixed inside L3.)
3. **Queued lead re-analysis was failing the same way** — same missing header, so every recompute triggered by a text, call or meeting was rejected. (L1 — fixed and proven on staging.)
4. **Six AI call sites were pointed at a wrong address** and silently failing: WhatsApp classification, reply suggestions, style extraction, the audio transcription path. (E-S1a — fixed; the WhatsApp one is deliberately left switched off until its consent logic is reviewed, because un-breaking it would have started auto-texting unknown numbers.)
5. **Staging had 12 cron jobs with the API key written into each command.** Now 17, matching production, all reading from the encrypted vault, with only the automatic sender switched off. (Harness.)

## What the review layers are catching
Every unit goes through four gates: the worker builds it → an independent reviewer reads every line → Codex reviews the PR → the staging job runs it against the real database. Real defects caught before merge so far: a wrong-customer delete race on the lead page, an automatic WhatsApp reply that would have woken up and texted strangers, three separate ways a genuine customer question could have been buried by the new Queue filters, and a misconfigured sender that would have re-spent AI credits every 15 minutes. None reached production.

## Confidence
**~80%.** The whole loop is real now — build, review, Codex, staging, merge — and two units have gone through it end to end. The two facts that would take it to ≥95%: the AI key on staging so G-C's send test runs and you observe one real email, and one production batch applied cleanly with `cron_run_log` quiet for an hour afterwards.
