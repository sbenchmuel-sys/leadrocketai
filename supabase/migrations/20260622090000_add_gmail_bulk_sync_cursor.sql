-- Per-connection cursor for the scheduled gmail-bulk-sync sweep.
--
-- The cron path (cron-dispatcher -> gmail-bulk-sync) processes a connection owner's
-- leads under a run-wide time budget. Without persisted progress, a page that does
-- not finish within the budget would be restarted from the same head rows on every
-- run, so the tail rows could be permanently skipped. This cursor lets each run
-- resume exactly where the previous one stopped.
--
-- Written only by the gmail-bulk-sync edge function (service role). No RLS policy
-- change: gmail_connections token columns are already service-role-only, and this
-- is non-sensitive bookkeeping.
alter table public.gmail_connections
  add column if not exists bulk_sync_cursor integer not null default 0;

comment on column public.gmail_connections.bulk_sync_cursor is
  'Rotating offset into this connection owner''s leads (ordered by id, scoped by owner_user_id + workspace_id) for the scheduled gmail-bulk-sync sweep. Advanced each run by the number of leads actually synced; wraps modulo the owned-lead count. Service-role only.';
