# PROGRESS.md — Build status by feature

Working state of major in-flight features.

- ✅ shipped to `main` (and applied via Lovable when a migration is involved)
- 🚧 in progress
- ⬜ planned, not started

When a phase fully ships, move it to a `## Completed` section at the bottom of the file or remove it entirely. Don't let ✅ checklists pile up forever — `CLAUDE.md` covers durable knowledge; this file is just the working board.

## Lead Candidates pipeline (started 2026-04-29)

Build sequence (spec: GitHub issue #3):

- ✅ PR #3/4 — data layer (`lead_candidates` + dismiss-list tables, RLS). Applied via Lovable.
- ✅ PR #4 — detection hook (`detect-lead-candidates` edge fn, `_shared/leadCandidateDetection.ts`, cron migration).
- ✅ PR #5 — AI scoring (`score-lead-candidate` edge fn, 10-min cron, Lovable AI gateway w/ Gemini Flash Lite). Advisory only in V1 — never auto-dismisses.
- ✅ PR #6 — Lookback seed (`lookback-seed-candidates` edge fn, hourly cron). Adds `lookback_seed_completed_at` column to `gmail_connections` + `mail_accounts`; adds `lookback_seed_window_days` (default 30) to `workspaces`. Existing accounts are backfilled as already-seeded so only future connects trigger a scan.
- ⬜ PR #7–10 — UI + bulk actions + digest + settings (Lovable).

`detect-lead-candidates` was added to `cron-dispatcher`'s `ALLOWED_TARGETS`. Its cron job is in `20260430000000_add_detect_lead_candidates_cron.sql`.

## Phase 2 — Deals: stakeholders + partners (started 2026-05-03)

Multi-stakeholder support without CRM bloat. Two distinct concepts:

- **Stakeholders** = multiple leads at the same company on one deal, anchored by a champion (1:N via `leads.group_id` + `lead_groups`).
- **Partners** = third-party people (introducers, advisors, integrators) spanning multiple deals (M:N via `group_partners` join → existing `contacts` table).

PRs:

- ✅ PR 2.1 — Data layer: `lead_groups`, `leads.group_id`, `group_partners`. RLS, integrity triggers (deferred champion-membership, auto-cleanup empty groups), RPC helpers `create_lead_group_with_champion` and `set_lead_group_champion`. Migration: `20260503140000_lead_groups_and_partners.sql`.
- ✅ PR 2.2 — Stakeholders + Partners panels on lead detail page. New sidebar component `StakeholdersPartnersPanel` with two sections, "+ Add" dialogs (`AddStakeholderDialog`, `AddPartnerDialog`), champion-swap and remove actions. Query helpers in `src/lib/leadGroupQueries.ts`. Wired into `LeadDetail.tsx` sidebar.
- ⬜ PR 2.4 — Per-email reply targeting. The "respond to Liza when Ed's email is most recent" scenario. Per-row Reply buttons in `TimelineTab` + composer banner showing reply target with switch dropdown + AI prompt builder consumes `reply_to_interaction_id`.
- ⬜ PR 2.3 — Contact detail page (`/app/contacts/:id`). Cross-deal partner view — click a partner to see all groups they're on. Currently the partner click-through 404s — non-blocking but should follow PR 2.4.
