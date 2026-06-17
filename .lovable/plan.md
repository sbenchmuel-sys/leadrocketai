## Problem

In `PendingLeadsTab`, `deriveLeadDefaults` assigns motion based on the candidate's `source`. The `lookback_seed` source (mail SENT-folder scan) is **unconditionally** mapped to `motion: "outbound_prospecting"`. The scan picks up *any* historical thread where the rep sent at least one message — including threads the lead originally started, cold sends with no reply, and two-way warm conversations. All three end up in the cold-outbound prospecting bucket.

There are three bugs feeding the user's complaint:

1. **Misclassification (both providers)** — `lookback_seed` is treated as cold outbound regardless of real thread direction.
2. **Misleading "paused" badge (Gmail path only today)** — After approval, fire-and-forget `gmail-sync` populates `last_inbound_at`, which trips the blocker at `AutomationPreviewCard.tsx:135` (`"Lead has replied"`) → the card renders **"Lead has replied — automation paused"** on a lead the user never enrolled in automation.
3. **Outlook approval has no backfill at all** — `lookback-seed-candidates` correctly scans Outlook SENT (and seeds candidates), but `backfillLeadHistory` in `PendingLeadsTab.tsx` only invokes `gmail-sync`. There is no `outlook-sync` invocation, even though that function exists with an identical `{ leadId, leadEmail, maxResults }` API. Consequence for Outlook-mailbox workspaces: approved leads have **zero prior history synced** — no timeline, no `last_inbound_at`, no intent — and stay parked in cold `outbound_prospecting` even when they're warm historical contacts. The "paused due to reply" badge doesn't fire (no inbound was synced), but the underlying state is even worse: the lead looks brand new and is queued for cold cadence.

## Fix

### 1. Provider-aware backfill on approve

In `src/components/leads/PendingLeadsTab.tsx → backfillLeadHistory`:

- Detect which mail provider(s) the lead's owner has connected (look up `mail_accounts.provider` and/or `gmail_connections` for `owner_user_id`).
- Invoke `gmail-sync` for Gmail owners, `outlook-sync` for Outlook owners. If both exist (rare), invoke both. Pass `{ leadId, leadEmail, maxResults: 50 }` as today.
- Keep `recompute-lead-intelligence` afterwards.

This is the prerequisite for any motion reclassification — without it, Outlook leads have no signal to classify on.

### 2. Classify lookback_seed by real thread direction (primary)

In `createLeadFromCandidate`:

- For `lookback_seed` candidates, default the insert to the **warm** bucket: `motion: "inbound_response"`, `source_type: "gmail_inbound"` (or `"outlook_inbound"` if/when that source_type exists; otherwise keep `gmail_inbound` as the generic "synced mail history" marker — fine for now), `stage: "engaged"`. This guarantees no lookback lead lands in the cold prospecting playbook even if the backfill fails.
- **Await** `backfillLeadHistory` for `lookback_seed` (single + bulk paths; bulk capped at ~4 in parallel for responsiveness).
- After backfill, re-read `last_inbound_at` and `first_outbound_at` for the new lead:
  - `last_inbound_at IS NOT NULL` → keep `motion: "inbound_response"`, `stage: "engaged"` (truly warm — lead replied at some point).
  - `last_inbound_at IS NULL AND first_outbound_at IS NOT NULL` → demote to `motion: "outbound_prospecting"`, `stage: "engaged"` (rep sent, lead never replied — historical cold contact).
  - Neither set (backfill returned nothing) → leave at the warm default; safer than mis-cold-prospecting.

Executor-consent gate still applies (`automation_mode` stays `NULL` on approval, per the existing memory rule), so no auto-sends regardless.

### 3. Suppress "paused" badge when automation was never enabled (defensive)

In `src/components/lead/AutomationPreviewCard.tsx`:

- Gate `safetyPaused` on "automation has ever been enabled" — `automation_mode IS NOT NULL` OR `eligible_at` was ever set OR an active `next_action_key` from a real sequence. When the lead has never been enrolled, blockers are not relevant; show the normal "Enable automation" CTA. We can optionally disable the Enable button with a tooltip ("Lead has already replied — review thread before enrolling") when `last_inbound_at` exists, but no "paused" framing.
- Belt-and-braces: even if classification (step 2) misses an edge case, the user no longer sees the misleading badge.

### 4. One-off backfill for already-approved misclassified leads

Migration to fix pilot data the broken path already produced. Conservative scope:

- For leads where `source = 'lookback_seed'` (or `source_type = 'outbound_prospecting'` AND created via approval — joinable via `lead_candidates.resolved_lead_id`), AND `automation_mode IS NULL` AND `eligible_at IS NULL`, AND `created_at > now() - interval '60 days'`:
  - If `last_inbound_at IS NOT NULL` → set `motion = 'inbound_response'`, `stage = 'engaged'`.
  - Leave others alone (could be intentional cold sequences).
- For Outlook-owner leads in that same approved-from-lookback set with no timeline rows: log them in a one-off audit table or just note in the migration that a manual "re-run backfill" action will be added (separate UI affordance), since synchronously re-syncing dozens of mailboxes inside a migration isn't appropriate.

## Technical details

Files changed:
- `src/components/leads/PendingLeadsTab.tsx` — provider-aware `backfillLeadHistory`; warm-by-default insert for `lookback_seed`; awaited backfill + post-backfill motion reconciliation; bulk path concurrency cap.
- `src/components/lead/AutomationPreviewCard.tsx` — `safetyPaused` only when automation has been enabled.
- New migration `supabase/migrations/<ts>_reclassify_lookback_inbound_leads.sql` — one-time UPDATE for the affected historical rows (Gmail path; Outlook path documented for follow-up).

Not changed:
- `lookback-seed-candidates` edge function — scan logic stays SENT-only for both providers.
- `gmail-sync` / `outlook-sync` — already have the right per-lead API.
- Executor / sender consent logic — untouched.

## Out of scope

- Reworking lookback to inspect threads bidirectionally at scan time.
- Renaming motion semantics or introducing a new "historical_contact" motion.
- Building an admin "re-run mail backfill for these leads" UI for Outlook (called out as follow-up).