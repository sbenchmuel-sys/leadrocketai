# CLEANUP.md — One-time deletions awaiting verification

Files, flags, and migrations confirmed safe to remove based on past audits, but not yet deleted. When you delete an entry, remove its line from this file.

`CLAUDE.md` keeps the durable rule: don't delete code without checking `cron-dispatcher` allowlists, `cron.job`, and other edge functions first. This file is just the working list of items already past that check.

## Pending (audited 2026-04-27)

- `src/components/AuthDebugPanel.tsx` — exported, never imported.
- `src/hooks/useGmailAutoSync.ts` — already commented as "removed" upstream; file was forgotten.
- `admin_tuning` flag in `src/lib/featureFlags.ts` — defined but never checked.
- The migration `20260106083245_*.sql` references a different Supabase project (`umqhdxjtgarwkdpwsxrm`) and a non-existent `gmail-background-sync` function. Verify no live `cron.job` row matches `gmail-background-sync-job` before deletion.

## Pending audits

- **Workspace-consistency triggers across the schema.** Codex flagged the meeting-recap tables as missing `enforce_<child>_<parent>_workspace` guards; those were added in `20260511120000_enforce_meeting_workspace_consistency.sql`. The same gap likely exists on most other workspace-scoped tables that hold FKs to other workspace-scoped tables. Audit and add triggers (or document why one isn't needed) for at least:
  - `calendar_events` — has `lead_id` FK, no enforcement
  - `lead_timeline_items` — has `lead_id`, `contact_id`, `conversation_id`, `source_id` FKs, no enforcement
  - `automation_log` — has `lead_id`, `mail_account_id` FKs, no enforcement
  - `lead_groups` — `champion_lead_id` is guarded by `validate_lead_group_champion()`, but check other FKs
  - Sweep the rest of the schema for `workspace_id uuid NOT NULL` tables with FKs to other workspace-scoped tables
  Plan: data-audit each table for existing cross-tenant rows (`SELECT ... WHERE parent.workspace_id <> child.workspace_id`) before adding the trigger so the migration doesn't fail on legacy data. Then mirror the `enforce_contact_lead_workspace` pattern.
- **Extend the existing `enforce_contact_lead_workspace` trigger.** Currently fires on `BEFORE INSERT OR UPDATE OF lead_id` only. Updating `contacts.workspace_id` alone bypasses the check. Change to `UPDATE OF workspace_id, lead_id` to close the gap, matching the convention adopted in `20260511120000_*.sql`.
