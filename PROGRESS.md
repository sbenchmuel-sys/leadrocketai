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
- ✅ PR 2.3 — Contact detail page (`/app/contacts/:id`). Cross-deal partner view — main column lists every group/deal the contact is linked to (clickable to the champion's lead detail page); side panel has editable name + company with auto-save on blur, read-only email joined from `contact_identities`. RLS-aware: fields render disabled with tooltip when the user is neither the assigned rep nor a workspace admin. Resolves the `StakeholdersPartnersPanel` 404. New file: `src/pages/ContactDetail.tsx`. Query helpers added to `src/lib/leadGroupQueries.ts`.
- ⬜ Deferred — make contact email editable on the contact detail page (multi-table write to `contact_identities` with UNIQUE collision handling).

## Email-send safety hardening

After the 5am ET incident on 2026-04-30 (multiple safeguards failed independently), three patches landed and two more are queued.

Shipped:
- ✅ Consent gate in `syncEngine` + `automation-executor` eligible-leads queries — won't schedule or send for leads without explicit `automation_mode`.
- ✅ Workspace timezone fix — `workspaces.timezone` column + Intl-based `checkSendWindow` + fail-closed when timezone is null. Cliff backfilled to `America/New_York`. Migration: `20260430200000_workspace_timezone.sql`.

Queued:
- ⬜ New-lead 24h cooldown — single check at top of `automation-executor`'s per-lead loop: if `now() - lead.created_at < 24h`, skip + push `eligible_at` forward. Catches CSV imports, candidate approvals, and any future ghost-queue regression.
- ⬜ Volume tripwire — log a `volume_alert` row in `cron_run_log` when a workspace exceeds N sends per 15-min window. Doesn't block sends, just gives a queryable signal.

Lovable handoff still pending:
- ⬜ Workspace timezone settings dropdown UI. Until shipped, only Cliff's workspace can run automation (any other workspace has `timezone IS NULL` and the gate fail-closes).
