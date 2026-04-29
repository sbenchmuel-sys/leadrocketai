# CLAUDE.md — DrivePilot guardrails for AI agents

Read before making changes. This file documents project-specific constraints that aren't obvious from the code alone.

## What this project is

**DrivePilot** (codebase name: `leadrocketai-main`) is a B2B sales automation SaaS in pilot stage. AI-generated outreach across email, SMS, WhatsApp, phone; learns per-workspace writing style; tracks deal intelligence. Founder-led B2B teams (2–25 reps) are the ICP.

Stack: React 18 + Vite + Tailwind + shadcn/ui frontend; Supabase (Postgres + RLS + Edge Functions in Deno) backend; Lovable Cloud for build/deploy.

See `README.md` for architecture detail.

## Platform constraints — do not change

- **Lovable Cloud is the deployment platform.** No CI pipelines, no monorepo/workspace layouts, no unusual build tools. Stick to vanilla Vite.
- **`.env` is auto-managed by Lovable Cloud.** Don't edit manually. `.env.example` is the documented schema.
- **`.lovable/` folder** is Lovable's bookkeeping. Don't touch.
- **Lovable AI may push directly to `main`** — branch protection on `main` would break Lovable. Don't enable it.

## Mid-migration areas — do not roll back

- **`interactions` (legacy) → `lead_timeline_items` (canonical)** — `lead_timeline_items` is the canonical cross-channel comms ledger. `interactions` is being retired. Several files dual-read both during the cutover. Do not reintroduce writes to `interactions`. The `TODO(cleanup)` markers in `src/lib/leadActivity.ts` and `src/lib/supabaseQueries.ts` track this.
- **`automation_log` (singular) vs `automation_logs` (plural)** — different schemas, both active. Singular = execution lifecycle tracker. Plural = decision log. Plan: rename `automation_logs` to `automation_decisions` once dependencies are unwound. Don't merge them prematurely.
- **`match_knowledge_chunks_v2`** is the canonical RPC. v1 and the unnumbered version are deprecated. Don't reintroduce calls to the old signatures.

## Cron jobs — two places

- **Authoritative source**: pg_cron jobs in the live database. Inspect with:
  ```sql
  SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobname;
  ```
- **Codified mirror**: the most recent `supabase/migrations/*_codify_cron_jobs.sql` captures the live state for IaC/audit purposes.

When changing a schedule, update both. The DB is the truth; the migration is the audit trail. **Re-running the codify migration is safe** — it deletes-then-recreates each named job.

## Public product commitments — code must honor

These are not just marketing claims — they constrain implementation:

- **Raw message bodies auto-purge after 72 hours** — enforced by `message-cleanup` edge function (hourly cron).
- **Call audio + transcripts auto-purge after 90 days** — verify retention logic before changing call pipeline.
- **OAuth tokens encrypted at rest with AES-256-GCM** — `supabase/functions/_shared/encryption.ts`. Never store unencrypted.
- **Workspace isolation enforced via RLS** — `is_workspace_member()` and `is_workspace_admin()` SECURITY DEFINER helpers are used in all user-facing policies.
- **No public signup during pilot phase** — invited workspaces only.

## Sensitive subsystems

- **`ai_task` edge function** (`supabase/functions/ai_task/index.ts`) is the central AI gateway for all draft/analysis/classification. It's large and growing — modularize carefully if you touch it.
- **`automation-executor`** is the production sender. Guardrails (OOO detection, opt-out, dedup, instant pause on inbound) are load-bearing — pilots' real customers see what this function emits.
- **`promote-winning-interactions`** runs every 6h and feeds the Sales Brain (the core differentiator). Do not delete or disable.
- **`cron-dispatcher`** is the only allowed entry point for scheduled jobs. New scheduled targets must be added to its `ALLOWED_TARGETS` set AND have a corresponding cron job.

## Things that look like ghost code but aren't

- **`promote-winning-interactions`** — appears unused at the call-site level; only invoked via cron. Don't delete.
- **`build-lead-context`** — invoked from edge functions, may not show direct UI calls. Don't delete.
- **`extract-profile-from-kb`** — called within edge function context.

When in doubt: grep for the function name in `cron-dispatcher` allowlists, in `cron.job` table, and in other edge functions before assuming it's dead.

## Things that ARE safe to delete (audited 2026-04-27)

- `src/components/AuthDebugPanel.tsx` — exported, never imported.
- `src/hooks/useGmailAutoSync.ts` — already commented as "removed" upstream; file was forgotten.
- `admin_tuning` flag in `src/lib/featureFlags.ts` — defined but never checked.
- The migration `20260106083245_*.sql` references a different Supabase project (`umqhdxjtgarwkdpwsxrm`) and a non-existent `gmail-background-sync` function. Verify no live `cron.job` row matches `gmail-background-sync-job` before deletion.

## Lovable migration workflow (confirmed 2026-04-29)

External PRs (from Claude/VS Code) land migration files as SQL in `supabase/migrations/`. **Lovable does NOT auto-apply these.** After a PR is merged, tell Lovable in its chat: "Apply migration `<filename>`." Lovable runs it against the live Supabase database AND regenerates `src/integrations/supabase/types.ts`. Both steps happen together — do not regenerate types separately.

When Lovable applies a migration, it creates its own copy with a `<timestamp>_<uuid>.sql` filename (same SQL, different name). This is expected.

## Lead Candidates pipeline (started 2026-04-29)

Build sequence tracking (spec: GitHub issue #3):
- ✅ PR #3/4 — data layer (`lead_candidates` + dismiss-list tables, RLS). Applied via Lovable.
- ✅ PR #4 — detection hook (`detect-lead-candidates` edge fn, `_shared/leadCandidateDetection.ts`, cron migration).
- ✅ PR #5 — AI scoring (`score-lead-candidate` edge fn, 10-min cron, Lovable AI gateway w/ Gemini Flash Lite). Advisory only in V1 — never auto-dismisses.
- ⬜ PR #6 — Lookback seed (30-day retroactive scan on first mail-account connect).
- ⬜ PR #7–10 — UI + bulk actions + digest + settings (Lovable).

`detect-lead-candidates` was added to `cron-dispatcher`'s `ALLOWED_TARGETS`. Its cron job is in `20260430000000_add_detect_lead_candidates_cron.sql` and must be applied via Lovable migration tool.

## Open hazards (separately tracked)

- **Supabase anon key is hardcoded in 11 cron commands** (`https://ntzeiflqqluwgdfmatjh.supabase.co/...`). When the anon key rotates, all 11 crons must be updated together OR they all break silently.
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
