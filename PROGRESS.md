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
- ✅ PR 2.4 — Per-email reply targeting + group-aware timeline + Follow-up button system. Per-row Reply on `email_inbound` rows (thread-scoped clearing rule via `to_emails`), per-row Follow-up on `email_outbound` rows, shared Snooze/Dismiss popover backed by `timeline_followup_state`, `EmailActionDialog` accepts `replyToTimelineItem`, `reply_to_thread` prompt extended with `{{TARGET_INBOUND_MESSAGE}}`, group-aware `getGroupTimelineItems` reader, `outlook-send` Sent Items lookup for `provider_message_id` capture. App-wide Dismiss in `ActionRequiredPanel` / `PriorityActions` backed by `leads.action_permanently_dismissed`. Migrations: `timeline_followup_state` table + `set_timeline_followup_state` RPC, `leads.action_permanently_dismissed`. Shipped via [PR #8](https://github.com/sbenchmuel-sys/leadrocketai/pull/8).
- ✅ PR 2.4-bugfixes — per-lead Follow-up rule (was per-thread, surfaced too many "always" pills), Reply gets matching Snooze/Dismiss popover, visual rebalance (Reply now filled blue pill, Follow-up demoted to ghost button, dropped amber), auth-warmup fix on `setTimelineFollowupState`, `extractBareEmail` RFC-2822 helper, subtle ring on freshest unreplied inbound (≤6h old). Shipped via [PR #9](https://github.com/sbenchmuel-sys/leadrocketai/pull/9).
- ✅ PR 2.3 — Contact detail page (`/app/contacts/:id`). Cross-deal partner view — main column lists every group/deal the contact is linked to (clickable to the champion's lead detail page); side panel has editable name + company with auto-save on blur, read-only email joined from `contact_identities`. RLS-aware: fields render disabled with tooltip when the user is neither the assigned rep nor a workspace admin. Resolves the `StakeholdersPartnersPanel` 404. New file: `src/pages/ContactDetail.tsx`. Query helpers added to `src/lib/leadGroupQueries.ts`.
- ⬜ Deferred — make contact email editable on the contact detail page (multi-table write to `contact_identities` with UNIQUE collision handling).

**Deferred follow-ups (uncovered during PR 2.4 testing — track as work surfaces):**

- Backfill `to_emails` / `cc_emails` on outbound rows synced before April 30, 2026 — currently fail-closed; deferred until needed.
- `from_email` storage inconsistency at the sync layer (some rows bare email, some RFC-2822 wrapped). Frontend `extractBareEmail` helper compensates; sync-side normalization deferred.
- `outlook-send` does not write `provider_message_id` for follow-ups on rep's own outbounds when the Sent Items lookup misses (graceful degradation; track miss rate via the `mail.outlook.sent_items_capture_missed` log event).
- Reply / Follow-up logic is currently email-only. Generalizing to SMS / WhatsApp inbound rows is deferred.
- Per-row OOO/bounce flags on `lead_timeline_items` (today: detected by UI regex on `from_email` / `subject`).
- Calendar invite reply detection (target subject "Invitation:" produces an awkward draft).
- Removed-stakeholder historical interactions visibility hint on group timeline.
- Realtime updates inside an open `EmailActionDialog` when timeline changes.

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

## Outreach (cold campaigns) — full plan in `CAMPAIGN_MANAGER_BUILD_PROMPTS.md`

Rep-facing name is **"Outreach"**; underlying code keeps the `campaigns` / `campaign_steps` names. Build order A → B → D → 0 → C, with E alongside C.

- 🚧 **Unit A — foundation (data + thin page + 3-step setup + saving).** Reuses the existing `campaigns` / `campaign_steps` tables and `assignCampaignToLead`. NEW in this unit:
  - Migration `20260602000000_campaign_foundation.sql`: adds `campaigns.campaign_type` (`general`/`industry`), `campaigns.status` (`draft`/`active`/`paused`/`completed`), `campaigns.knowledge_ref`; **relaxes campaigns + campaign_steps management RLS from `is_workspace_admin` → `is_workspace_member`** (every rep builds their own; workspace isolation preserved); adds workspace `campaign_suppression_list` (do-not-contact) table with member RLS. No edge function → `config.toml` untouched. Does NOT touch `interactions`/`lead_timeline_items` or `automation_log`/`automation_logs`.
  - **Draft campaigns never drive live sends (additive guarantee).** `automation-executor` calls `loadCampaignForLead` → `resolveCampaignInstruction` on every eligible lead, and the loader keyed only on `campaign_id`. `_shared/campaignStepLoader.ts` now returns null unless `campaigns.status = 'active'`, so a lead added to a *draft* outreach for membership keeps its pre-campaign (legacy `action_instructions`) send behavior until the campaign is activated (Unit C). The migration backfills all pre-existing campaigns to `active` so nothing currently live changes; the loader treats a missing `status` (pre-migration) as active to fail safe. (Found by Codex on PR #56.)
  - **Lead assignment is guarded at the write (two fail-closed filters).** The picker uses the owner-scoped, no-campaign-filter `getLeadsList()`, so `addLeadsToCampaign` constrains the UPDATE to (a) the campaign's own `workspace_id` — a multi-workspace rep can't stamp a cross-workspace lead in — and (b) `campaign_id IS NULL` — never pull a lead OUT of an outreach it already belongs to (doing so would silently halt an active campaign's sends and, since drafts are loader-gated, drop the lead to legacy instructions). It returns the actually-added count; callers surface the skipped count instead of a silent success. (Codex P1 ×2, PR #56.)
  - Mutations in `src/lib/campaignQueries.ts`: `createCampaignWithSteps`, `updateCampaign`, `replaceCampaignSteps`, `deleteCampaign`, `fetchCampaignLeads`, `addLeadsToCampaign`, suppression CRUD. Default 9-touch plan + default `global_instructions` prompt in `src/lib/campaignDefaults.ts`.
  - UI: thin `/app/automations` list (+ empty state, "Do-not-contact" dialog), `/app/automations/new` 3-step wizard, `/app/automations/:id` detail (script + People + Edit instructions). Nav item "Outreach".
  - Decisions (confirmed with product): any member can manage; General/Industry maps onto `campaign_steps.variant_group` (one living campaign, base steps = `variant_group NULL`, Unit B fills per-industry variants); knowledge file captured as a `knowledge_ref` reference only — ingestion wired in Unit B.
- ⬜ Units B / D / 0 / C / E — not started.

**Carry-forward scope notes for later units (sized deliberately so estimates aren't undersized):**

- **9-touch resolver extension is a MULTI-POINT change on a LIVE SEND PATH (Unit B) — test-backed, both copies in sync.** `_shared/campaignResolver.ts` hard-wires `4` in several places: `resolveStepNumber` clamps to `Math.max(1, Math.min(n, 4))`; step-type/framework selection branches on `step === 4` (breakup/value_add); generation hints branch on `step === 4`; the prompt emits a literal `"Sequence: Step X of 4"`; plus `total_steps`, and `CHANNEL_STEP_CONSTRAINTS` / `DEFAULT_STEP_CONFIG` / `CHANNEL_CTA_DEFAULTS` / `ACTION_KEY_TO_STEP` in `campaignTypes.ts` (only steps 1–4 today). DB is already fine — `campaign_steps.step_number` allows 1–10. Hard requirements before merge:
  - **There are TWO resolvers** — `src/lib/campaignResolver.ts` (client, used by `generateDraft.ts` manual drafting) and `supabase/functions/_shared/campaignResolver.ts` (server, used by `automation-executor`, the production sender). Both must be changed and kept in sync (divergence is a known repo hazard). Same for the two `campaignTypes.ts`.
  - **Golden/snapshot tests (vitest is present, v3.2.4)** proving existing 4-step `action_key`s (`send_pre_1..4`, `nurture_1..4`) resolve **byte-identical** before vs. after the change — on a live send path, "asserted unchanged" must be proven, not assumed.
- **Draft-gate location + Unit B test (re #1).** The `status='active'` send-path gate already exists and is merged — `supabase/functions/_shared/campaignStepLoader.ts:83-84` (`loadCampaignForLead`), the only path a STRUCTURED campaign reaches sending (`automation-executor`). It is NOT in `campaignQueries.ts` (client query layer) by design. The client manual-draft path (`generateDraft.ts` → `buildCampaignPayloadFields`) uses the legacy `leads.action_instructions` text blob, never the structured campaign, so drafts can't leak there either. Unit B must (a) add a test proving `draft`/`paused`/`completed` campaigns return null from `loadCampaignForLead` (skipped on the send path), and (b) use a SEPARATE `loadCampaignById` for AUTHORING-time generation that intentionally ignores status — authoring a draft is the whole point; the gate is the send/live-lead path only.
- **Knowledge file (`knowledge_ref`) is dealership-authored collateral that PERSISTS — retention framing corrected.** The 72h/7-day purge applies to customer MESSAGE bodies, not the dealership's own uploaded reference material (flyers, one-pagers, product/offer sheets), which is meant to live in the KB (`kb_chunks`) indefinitely. `knowledge_ref` files are expected to be dealership-authored marketing/reference material ONLY. The real guard for Unit B: **never ingest customer email/message content into `kb_chunks`** (which persists indefinitely) in a way that bypasses the message-body purge. Unit B wires the uploaded file → `process-knowledge-document`; it must not pipe lead/customer message bodies into that path.
- **Suppression enforcement belongs to UNIT C (the send unit), not Unit B.** (Corrected — earlier notes said Unit B; Unit B has no send path. The canonical Unit C brief already owns "check the do-not-contact list before enrolling AND immediately before each send; fail closed.") Unit A only stores `campaign_suppression_list` + CRUD + UI; nothing reads it yet (safe — no send path). HARD REQUIREMENT for Unit C: wire the check into `automation-executor`'s send guard **in the same unit that enables sending — never after**, and **compose with** (not replace) the existing `leads.unsubscribed` / `stop_on_unsubscribe` opt-out (both checked). The Unit A code comment in `campaignQueries.ts` and the dialog copy have been corrected to point at Unit C so the commitment isn't orphaned.
- **LinkedIn channel — requested, deferred to B/C (not in Unit A).** Reps want LinkedIn as an outreach channel. Intentionally omitted from the Unit A wizard: there is no `linkedin` in `CanonicalChannel` (`email | whatsapp | sms | voice | meeting`), so a chip now would create touches that generate/send nothing until B/C — a dead control on a finished-defaults screen. Plan: the channel plumbing (extend `CanonicalChannel` + `channels.ts` label/icon/availability — gate on the lead's existing `linkedin_url` — and the `campaignTypes.ts` channel constants `CHANNEL_STEP_CONSTRAINTS` / `CHANNEL_CTA_DEFAULTS` + `resolveChannel`) lands in **Unit B** so authoring can generate LinkedIn copy; the **send behavior lands in Unit C**, which already specs LinkedIn as a MANUAL touch (LinkedIn blocks link message pre-fill → silently copy the prepared message to the clipboard, then open the profile/conversation; the rep pastes and sends). Add the wizard chip when that behavior is real, not before.
