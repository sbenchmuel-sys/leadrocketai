# CLAUDE.md — DrivePilot guardrails for AI agents

Read before making changes. This file documents project-specific constraints that aren't obvious from the code alone.

Stack: React 18 + Vite + Tailwind + shadcn/ui frontend; Supabase (Postgres + RLS + Edge Functions in Deno) backend; Lovable Cloud for build/deploy. See `README.md` for architecture detail.

## Platform constraints — do not change

- **Lovable Cloud is the deployment platform.** No CI pipelines, no monorepo/workspace layouts, no unusual build tools. Stick to vanilla Vite.
- **`.env` is auto-managed by Lovable Cloud.** Don't edit manually. `.env.example` is the documented schema.
- **`.lovable/` folder** is Lovable's bookkeeping. Don't touch.
- **Lovable AI may push directly to `main`** — branch protection on `main` would break Lovable. Don't enable it.

## Mid-migration areas — do not roll back

- **`interactions` (legacy) → `lead_timeline_items` (canonical)** — `lead_timeline_items` is the canonical cross-channel comms ledger. `interactions` is being retired. Several files dual-read both during the cutover. Do not reintroduce writes to `interactions`. The `TODO(cleanup)` markers in `src/lib/leadActivity.ts` and `src/lib/supabaseQueries.ts` track this.
- **`automation_log` (singular) vs `automation_logs` (plural)** — different schemas, both active. Singular = execution lifecycle tracker. Plural = decision log. Plan: rename `automation_logs` to `automation_decisions` once dependencies are unwound. Don't merge them prematurely.
- **`match_knowledge_chunks_v2`** is the canonical RPC. v1 and the unnumbered version are deprecated. Don't reintroduce calls to the old signatures.
- **`timeline_followup_state`** is keyed by `timeline_item_id` with no event-type discriminator. Naming says "followup" but the table now also gates Reply visibility (PR 2.4-bugfixes). Future cleanup candidate: rename `followup_snoozed_until` / `followup_dismissed_at` columns to `snoozed_until` / `dismissed_at` since the row already implies the scope.

## Cron jobs — two places

- **Authoritative source**: pg_cron jobs in the live database. Inspect with:
  ```sql
  SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobname;
  ```
- **Codified mirror**: the most recent `supabase/migrations/*_codify_cron_jobs.sql` captures the live state for IaC/audit purposes.

When changing a schedule, update both. The DB is the truth; the migration is the audit trail. **Re-running the codify migration is safe** — it deletes-then-recreates each named job.

## Public product commitments — code must honor

These are not just marketing claims — they constrain implementation:

- **Raw message bodies auto-purge within 72 hours of receipt. For inbound emails specifically, the purge is delayed until AI classification has written a durable summary, with an absolute 7-day hard cap.** Enforced by `message-cleanup` edge function (hourly cron) — which delegates to the `expire_old_messages()` SQL function (also scheduled hourly as a DB-level fallback). Covers:
  - `messages.body_ciphertext` (WhatsApp/SMS) — unconditional 72h purge; no classifier path.
  - `interactions.body_text` (email body) — outbound rows purge at 72h unconditionally; **inbound** rows wait for the paired `lead_timeline_items` row's `intent IS NOT NULL` OR the 7-day hard cap.
  - `lead_timeline_items.snippet_text` (email snippet) — non-inbound `event_type`s (outbound, system_note, meeting, …) purge at 72h unconditionally; **inbound** rows wait for this row's own `intent IS NOT NULL` OR the 7-day hard cap.

  Each row gets `expires_at = occurred_at + 72h` on insert; the inbound gate adds the classifier branch on top. The `classify-inbound` cron writes a durable paraphrased `ai_summary` to `metadata_json` before the gated purge fires; downstream context builders (`build-lead-context`, `ai_task`) fall back to `ai_summary` when raw body is gone. Metadata (subjects, participants, `ai_summary`, FKs) is preserved indefinitely.
- **Call audio + transcripts auto-purge after 90 days** — verify retention logic before changing call pipeline.
- **OAuth tokens encrypted at rest with AES-256-GCM** — `supabase/functions/_shared/encryption.ts`. Never store unencrypted.
- **Workspace isolation enforced via RLS** — `is_workspace_member()` and `is_workspace_admin()` SECURITY DEFINER helpers are used in all user-facing policies.
- **No public signup during pilot phase** — invited workspaces only.
- **Per-row email follow-up reminders** stored in `timeline_followup_state` (workspace-scoped via FK + RLS, PK on `timeline_item_id`). Reuses the same table for both inbound (Reply) and outbound (Follow-up) snooze/dismiss state.
- **Lead-level permanent action dismissal** stored in `leads.action_permanently_dismissed`. Auto-cleared by `syncEngine` when a fresh inbound arrives, parallel to the existing `action_dismissed_at` reset.

## Sensitive subsystems

- **`ai_task` edge function** (`supabase/functions/ai_task/index.ts`) is the central AI gateway for all draft/analysis/classification. It's large and growing — modularize carefully if you touch it.
- **`automation-executor`** is the production sender. Guardrails (OOO detection, opt-out, dedup, instant pause on inbound) are load-bearing — pilots' real customers see what this function emits.
- **`promote-winning-interactions`** runs every 6h and feeds the Sales Brain (the core differentiator). Do not delete or disable.
- **`cron-dispatcher`** is the only allowed entry point for scheduled jobs. New scheduled targets must be added to its `ALLOWED_TARGETS` set AND have a corresponding cron job.
- **`set_timeline_followup_state` (SECURITY DEFINER RPC)** is the only allowed write path for per-row follow-up state. Authorization via `is_workspace_member()`. Frontend wrapper at `src/lib/supabaseQueries.ts:setTimelineFollowupState` includes auth-warmup (`getSession()`) and a single 400ms retry on transient auth errors only (PostgREST `42501` / "Not authenticated" / network). Anything else throws immediately.

## Timeline UI rules

The Reply / Follow-up button visibility on the lead detail timeline is non-trivial. Documented here so future agents don't re-derive it from code.

- **Reply button** (on `email_inbound` rows): visible when ALL of — it's the most recent inbound from that sender within its email thread (thread-scoped via `gmail_thread_id` / `conversation_id`, fallback to normalized subject); AND no later outbound in the same thread has the sender's email in `to_emails` (case-insensitive, **To only — Cc does NOT clear**); AND not a bounce / OOO; AND sender's lead not unsubscribed; AND no active snooze and not dismissed via `timeline_followup_state`.
- **Follow-up button** (on `email_outbound` rows): the `"always"`-visible state uses a **per-lead** rule — this row is the most recent outbound to this lead across ALL threads, AND >5 days old, AND no later inbound from this lead in any thread, AND not snoozed/dismissed. Otherwise `"hover"`. At most ONE always-visible Follow-up per lead. Older outbounds remain accessible via hover — supports "circle back to a specific email."
- **Both buttons** share the same caret + popover: Snooze 3/5/7 days, Dismiss (destructive), 5s undo toast. Backed by `timeline_followup_state`.
- **Subtle ring** (`ring-1 ring-primary/20`, no animation) on the freshest unreplied inbound when `occurred_at` is within the last 6h. Recomputed once per timeline reload, not per-tick.
- **`extractBareEmail` helper** in `src/components/lead/TimelineTab.tsx` strips RFC-2822 wrappers (e.g., `"Manu Rajendra <manu@acme.com>"` → `"manu@acme.com"`) before email comparison. Use it whenever comparing addresses extracted from `from_email` or `to_emails`.
- **Historical caveat:** outbound rows synced before April 30, 2026 may have empty `to_emails` / `cc_emails` in `metadata_json`. The Reply-clearing rule fails-closed (button stays visible) for these. Going-forward syncs populate correctly. A backfill is possible but deliberately deferred — see `PROGRESS.md`.

## Things that look like ghost code but aren't

- **`promote-winning-interactions`** — appears unused at the call-site level; only invoked via cron. Don't delete.
- **`build-lead-context`** — invoked from edge functions, may not show direct UI calls. Don't delete.
- **`extract-profile-from-kb`** — called within edge function context.
- **`set_timeline_followup_state` RPC** — invoked only via the `setTimelineFollowupState` wrapper from the timeline UI; no automation path calls it.

When in doubt: grep for the function name in `cron-dispatcher` allowlists, in `cron.job` table, and in other edge functions before assuming it's dead.

## Lovable migration workflow

External PRs (from Claude/VS Code) land migration files as SQL in `supabase/migrations/`. **Lovable does NOT auto-apply these.** After a PR is merged, tell Lovable in its chat: "Apply migration `<filename>`." Lovable runs it against the live Supabase database AND regenerates `src/integrations/supabase/types.ts`. Both steps happen together — do not regenerate types separately.

When Lovable applies a migration, it creates its own copy with a `<timestamp>_<uuid>.sql` filename (same SQL, different name). This is expected.

## Open hazards

- **Supabase anon key is hardcoded in 12 cron commands** (`https://ntzeiflqqluwgdfmatjh.supabase.co/...`). When the anon key rotates, all 12 crons must be updated together OR they all break silently.
- **Demo data fall-through in `src/lib/demoData.ts` (736 lines)** — imported by production query paths. If `VITE_DEMO_MODE` is misconfigured in prod, real users could see demo numbers. Gate explicitly.
- **Lead scoring exists client-side AND server-side** with no sync — `closingPowerUtils.ts` (client) vs `recompute-lead-intelligence` (server). Pick server as canonical.
- **Email send paths are duplicated 3x** — `ReplyComposer.tsx`, `mailProviders/GmailProvider.ts`, `useMailSync.ts`. Funnel through the provider.

## Where to look first

| Need | Look at |
|---|---|
| High-level architecture | `README.md` |
| Edge function entry points | `supabase/functions/<name>/index.ts` |
| Reusable backend logic | `supabase/functions/_shared/` |
| Schema | `supabase/migrations/` (chronological) |
| TypeScript DB types | `src/integrations/supabase/types.ts` (auto-generated, large) |
| AI prompt logic | `supabase/functions/_shared/prompts.ts` |
| Auth flow | `src/contexts/AuthContext.tsx` + `src/contexts/WorkspaceContext.tsx` |
| Pending one-time cleanups | `CLEANUP.md` |
| Build progress / WIP features | `PROGRESS.md` |
