# CLEANUP.md — One-time deletions awaiting verification

Files, flags, and migrations confirmed safe to remove based on past audits, but not yet deleted. When you delete an entry, remove its line from this file.

`CLAUDE.md` keeps the durable rule: don't delete code without checking `cron-dispatcher` allowlists, `cron.job`, and other edge functions first. This file is just the working list of items already past that check.

## Pending (audited 2026-04-27)

- `src/components/AuthDebugPanel.tsx` — exported, never imported.
- `src/hooks/useGmailAutoSync.ts` — already commented as "removed" upstream; file was forgotten.
- `admin_tuning` flag in `src/lib/featureFlags.ts` — defined but never checked.
- The migration `20260106083245_*.sql` references a different Supabase project (`umqhdxjtgarwkdpwsxrm`) and a non-existent `gmail-background-sync` function. Verify no live `cron.job` row matches `gmail-background-sync-job` before deletion.
