# CLEANUP.md — One-time deletions awaiting verification

Files, flags, and migrations confirmed safe to remove based on past audits, but not yet deleted. When you delete an entry, remove its line from this file.

`CLAUDE.md` keeps the durable rule: don't delete code without checking `cron-dispatcher` allowlists, `cron.job`, and other edge functions first. This file is just the working list of items already past that check.

## Pending (audited 2026-04-27)

- `src/components/AuthDebugPanel.tsx` — exported, never imported.
- `src/hooks/useGmailAutoSync.ts` — already commented as "removed" upstream; file was forgotten.
- `admin_tuning` flag in `src/lib/featureFlags.ts` — defined but never checked.
- The migration `20260106083245_*.sql` references a different Supabase project (`umqhdxjtgarwkdpwsxrm`) and a non-existent `gmail-background-sync` function. Verify no live `cron.job` row matches `gmail-background-sync-job` before deletion.

## Pending audits

- **Re-encrypt legacy plaintext OAuth tokens (migration note, added 2026-06-11).** All OAuth-token write paths (`mail_accounts.access_token/refresh_token` AND `gmail_connections.access_token_encrypted/refresh_token_encrypted`) now fail closed — tokens are always encrypted via `_shared/encryption.ts` (`encryptToken`, AES-256-GCM) and a missing `TOKEN_ENCRYPTION_KEY` aborts the write instead of storing plaintext (guard test: `src/test/mailAccountsTokenEncryption.test.ts`). But rows written **before** this change (while the key was unset, or via the old `catch → store plaintext` fallbacks) may still hold plaintext tokens; the read path (`safeDecryptToken`) tolerates them, so they work silently. This cannot be a SQL migration — the AES key lives only in the edge-function environment. Backfill plan: a one-off edge-function script (service role) that selects the token columns from both tables, skips rows where `isEncrypted(value)` is true, and rewrites the rest with `encryptToken(value)`. After the backfill is verified, remove the plaintext-tolerance branch in `safeDecryptToken` so reads fail closed too.

- **Workspace-consistency triggers across the schema.** Codex flagged the meeting-recap tables as missing `enforce_<child>_<parent>_workspace` guards; those were added in `20260511120000_enforce_meeting_workspace_consistency.sql`. The same gap likely exists on most other workspace-scoped tables that hold FKs to other workspace-scoped tables. Audit and add triggers (or document why one isn't needed) for at least:
  - `calendar_events` — has `lead_id` FK, no enforcement
  - `lead_timeline_items` — has `lead_id`, `contact_id`, `conversation_id`, `source_id` FKs, no enforcement
  - `automation_log` — has `lead_id`, `mail_account_id` FKs, no enforcement
  - `lead_groups` — `champion_lead_id` is guarded by `validate_lead_group_champion()`, but check other FKs
  - Sweep the rest of the schema for `workspace_id uuid NOT NULL` tables with FKs to other workspace-scoped tables
  Plan: data-audit each table for existing cross-tenant rows (`SELECT ... WHERE parent.workspace_id <> child.workspace_id`) before adding the trigger so the migration doesn't fail on legacy data. Then mirror the `enforce_contact_lead_workspace` pattern.
- **Extend the existing `enforce_contact_lead_workspace` trigger.** Currently fires on `BEFORE INSERT OR UPDATE OF lead_id` only. Updating `contacts.workspace_id` alone bypasses the check. Change to `UPDATE OF workspace_id, lead_id` to close the gap, matching the convention adopted in `20260511120000_*.sql`.
- **`CalendarReconsentModal` is dismissable contrary to PR #16's description.** PR #16 stated the modal should be blocking with no escape hatch ("cannot be dismissed by ESC, outside-click, or X"), but the current implementation renders a visible X button and lets `onOpenChange` set a `dismissed` flag that hides it. Restore the blocking behavior: remove the X, ignore `onOpenChange` close events, and prevent ESC/outside-click dismissal (Radix `onEscapeKeyDown` / `onPointerDownOutside` with `preventDefault`).
- **Frontend/backend OAuth scope lists are duplicated by necessity.** The Deno edge functions and the React hook run in different runtimes and can't import shared code. Today the backend Outlook scope list lives in `supabase/functions/_shared/outlookScopes.ts` and the frontend mirror lives in `src/hooks/useNeedsCalendarReconsent.ts` — both must be updated together. Google scopes have the same split between `supabase/functions/gmail-auth/index.ts` and the same hook. Consider generating one from the other via a build step (e.g., emit a `.ts` constants file from a single JSON manifest) if this duplication causes future drift bugs.
- **Out-of-order migration timestamps from Lovable's duplicate-application pattern.** Lovable's auto-generated migration copies (e.g. `20260511172006_<uuid>.sql`) carry later timestamps than the source migrations they duplicate. New migrations authored locally may end up with timestamps that precede Lovable's copies, which would cause `supabase db push` to skip them. Not an issue for the current Lovable-driven workflow but blocks fresh-environment provisioning. Audit existing migrations for out-of-order timestamps; consider a policy that new local migrations always use a timestamp strictly later than the latest file in `supabase/migrations/` (regardless of whether the latest is Lovable-generated).
