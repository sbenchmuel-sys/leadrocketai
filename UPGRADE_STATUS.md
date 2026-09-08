# DrivePilot master upgrade — checkpoint

Updated: 2026-09-08 15:30 (Israel time) · origin/main `ebb7030a` · staging QA gates are running (via the GitHub "Staging ops" job) · first merge (harness) imminent.

## OBSERVE — things only you can see or hear (each unblocks one PR)
_Nothing to observe yet._ The first item will be **G-C (PR #138)** once its staging tick can run — that needs `LOVABLE_API_KEY` on staging (DECIDE 1). When ready you'll get click-by-click steps: check one email in a real inbox for exactly one signature + one footer, click its unsubscribe link, and confirm a review-mode Send still works with the kill switch on.

## PRODUCTION — do in Lovable, in this order (batched; staging never waits for this)
_Nothing merged yet. Next up after the harness merges:_
- **Harness (#137)** — no production migration (its migration is staging-only; never tell Lovable to apply `20260908000000_codify_cron_jobs_staging.sql`). Functions to redeploy: `ai_task`, `automation-executor` (pure code moves — Lovable normally redeploys on push; if not, redeploy those two).

## DECIDE — what I need from you, and defaults I took
1. **[BLOCKING all AI-related QA] `LOVABLE_API_KEY` is not set on the staging project.** Supabase dashboard → *drivepilot-staging* → Edge Functions → Secrets → add `LOVABLE_API_KEY` (production's value is fine; staging AI calls bill to it). Optional: `OPENAI_API_KEY` for embeddings. Until then: harness can merge (no AI), but G-C's tick, L1's recompute and E-S1a's gateway checks can't complete on staging.
2. **Staging Twilio subaccount — unknown.** Default: C1's Twilio checks deferred; C2 waits. Free to change until C1 reaches QA.
3. **Outlook + real inbox test accounts — unknown.** Needed for the G-C and G-B observations. Default: I seed staging and tell you which inbox to check.
4. **Uploaded-notes risks now expire (L1).** Default taken: accept (AI re-derives risks from live evidence). Say so before L1 merges if you want upload-derived risks to persist; cost later = one small PR.
5. **WhatsApp auto-replies stay OFF by default (E-S1a)** behind `WHATSAPP_AUTO_REPLY_ENABLED=true` (unset everywhere). Default: keep off until G-M reviews consent. Free to flip per environment.
6. **Warm follow-ups now obey the "require a postal address" switch (G-C).** Check `COLD_REQUIRE_POSTAL_ADDRESS` in production before redeploying the executor; if it's `true`, workspaces with no mailing address stop getting automatic warm follow-ups (skipped + logged).
7. **Staging runs through a GitHub Actions job now** (`Staging ops`, PRs #141/#142, merged). Reason: this workspace's network policy blocks Supabase; GitHub's runners don't. It is manual-only, staging-only (refuses any input naming production), and does not gate anything. CLAUDE.md's "no CI pipelines" rule is about Lovable's build path, which is untouched — flag if you disagree.
8. **Staging's internal cron secret was rotated** to a value only staging knows (stored in staging's Vault + function secrets). The 17 staging cron jobs now read URL/key/secret from Vault — zero literal keys.
9. Product defaults from the plan (unchanged): purge crons OFF until outbound summaries exist, then 30 days · "call me, then connect" default with browser opt-in · Hebrew-first + English alternative for Israeli workspaces.
10. GitHub token is in the chat history — revoke when the program ends.

## Units
| Unit | Tier | Status | PR | QA |
|---|---|---|---|---|
| P0 harness | 2 | **ready to merge** — staging gate passed (Deno suite green, 17 vault-sourced cron jobs, idempotent apply, minute crons green, functions deployed); waiting on Codex's look at the last commit | [#137](https://github.com/sbenchmuel-sys/leadrocketai/pull/137) @ `c96cbcf4` | SHIP WITH NOTES; 2 Codex findings fixed (campaign scheduler stays active on staging; preflight proves the unsubscribe secret by name) |
| G-C executor safety | 1 | PR open · Codex green (3 P2s fixed, re-QA'd) · **staging tick waits on `LOVABLE_API_KEY`** · then your observation | [#138](https://github.com/sbenchmuel-sys/leadrocketai/pull/138) @ `76d362ee` | SHIP WITH NOTES (re-gated after fixes) |
| L1 lead data fixes | 2 | PR open · Codex green (1 P2 fixed) · staging checks queued (recompute needs the key) | [#139](https://github.com/sbenchmuel-sys/leadrocketai/pull/139) @ `31f17984` | SHIP WITH NOTES |
| E-S1a aiGateway | 2 | PR open · Codex green (1 P2 fixed) · staging checks wait on `LOVABLE_API_KEY` | [#140](https://github.com/sbenchmuel-sys/leadrocketai/pull/140) @ `4534e811` | HOLD → fixed → SHIP WITH NOTES |
| Staging ops job | 3 | **merged** (#141, #142) | — | Codex P1s fixed (secretless test job; explicit secret redaction) |
| C1 calling safety | 1 | queued — starts when G-C merges (one Tier 1 at a time) | | |
| Q1 → G-A/G-B/Q2 → E-S1b/C2 → L3 → L2/C3 → G-M → E-S2 → E-S3 → retention | | queued per the dependency graph | | |

## What the first live staging run taught us
- Staging had 12 cron jobs with the anon key written into each command; it now has 17 reading from Vault, matching production's job list, with only the automatic sender switched off.
- `LOVABLE_API_KEY` / `OPENAI_API_KEY` were never set on staging (the plan assumed they were).
- `ai_task` rejects the service-role key; it needs a signed-in user — the preflight now logs in as the test rep.
- Production runs 17 cron jobs, not the 10 the April codify file lists — worth a fresh codify on production later (not in this program).

## Follow-ups queued (small, not blocking)
- `promote-winning-interactions` (Sales Brain promotion) sends a non-chat body and has been failing on its own — separate PR later.
- Eval baseline (`coldTemplateEval.ts run`) PENDING until `LOVABLE_API_KEY` exists on staging.
- A fresh production cron codify migration (17 jobs) for the audit trail.

## Confidence
~70% (harness proven on staging; the QA loop — build → code review → Codex → staging job → report — is now real end to end). Next two facts that raise it: (1) `LOVABLE_API_KEY` on staging → G-C's tick runs and you observe the single-signature email (→ ≥90%); (2) G-C merged and one production batch applied cleanly with `cron_run_log` quiet for an hour (→ ≥95% per unit).
