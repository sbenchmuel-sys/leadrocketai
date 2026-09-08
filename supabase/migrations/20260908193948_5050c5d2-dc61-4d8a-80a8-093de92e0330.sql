alter table public.gmail_connections
  add column if not exists bulk_sync_cursor integer not null default 0;

comment on column public.gmail_connections.bulk_sync_cursor is
  'Rotating offset into this connection owner''s leads (ordered by id, scoped by owner_user_id + workspace_id) for the scheduled gmail-bulk-sync sweep. Advanced each run by the number of leads actually synced; wraps modulo the owned-lead count. Service-role only.';