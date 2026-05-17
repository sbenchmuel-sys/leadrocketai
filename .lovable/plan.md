## Problem

`leads.last_activity_at` is being bumped to **now()** every time a user runs an email sync, even when no new messages arrived. This makes the dashboard's "Last Activity" column show "Today" for every synced lead — misleading, and especially bad in a workspace already nervous about unexpected automation behavior.

Root cause is in `supabase/functions/_shared/syncEngine.ts` line 647:

```ts
last_activity_at: new Date().toISOString(),
```

This runs unconditionally on every per-lead sync (used by `useMailSync` → Gmail + Outlook single-lead sync). `gmail-bulk-sync` already does it correctly (max of inbound/outbound), but the per-lead path doesn't.

Several other writers also hardcode `new Date().toISOString()` even when the event being recorded has a real, earlier timestamp (`gmail-send`, `outlook-send`, `outlook-webhook`, manual upload, etc.). For genuinely new events that's fine (the event IS happening now), but it's fragile — any writer that forgets to set it correctly silently corrupts the field.

## Goal

`last_activity_at` should equal the timestamp of the **latest real activity** on the lead across all channels (email, WhatsApp, SMS, call, meeting, note), regardless of which code path wrote the timeline row.

## Fix — two layers

### Layer 1 (primary): DB trigger on `lead_timeline_items`

Add an `AFTER INSERT OR UPDATE` trigger on `lead_timeline_items` that does:

```sql
UPDATE leads
SET last_activity_at = GREATEST(
  COALESCE(last_activity_at, 'epoch'::timestamptz),
  NEW.occurred_at
)
WHERE id = NEW.lead_id
  AND NEW.occurred_at <= now() + interval '5 minutes';  -- clock-skew guard
```

Notes:
- `GREATEST` ensures we never move the field backwards.
- The 5-min ceiling prevents a bad row with a future `occurred_at` from poisoning the field.
- Skip channels that shouldn't count as activity if we decide any are noise (initially: count everything — system notes are rare and meaningful).
- Trigger is `SECURITY DEFINER` so it runs regardless of RLS context.

This makes the field self-healing and channel-agnostic. Future channels added (Teams transcripts, LinkedIn, etc.) get correct `last_activity_at` for free as long as they project to `lead_timeline_items` — which they already must per the canonical-interaction pattern.

### Layer 2: Fix `syncEngine.ts` to stop bumping the field on every sync

In `supabase/functions/_shared/syncEngine.ts`, replace the unconditional `new Date().toISOString()` with the same logic `gmail-bulk-sync` uses — max of `metrics.last_outbound_at` and `metrics.last_inbound_at`, and **don't include the field at all** if there are no dates (let the trigger / existing value stand, never overwrite with `now()`).

```ts
const activityDates = [metrics.last_outbound_at, metrics.last_inbound_at]
  .filter(Boolean)
  .map(d => new Date(d!).getTime());

if (activityDates.length > 0) {
  leadUpdate.last_activity_at = new Date(Math.max(...activityDates)).toISOString();
}
// else: omit — preserve existing value
```

With Layer 1 in place this is belt-and-suspenders, but it also cuts unnecessary writes on noop syncs.

### Layer 3 (one-time): backfill

Run a one-shot recompute so existing corrupted values are corrected immediately:

```sql
UPDATE leads l
SET last_activity_at = COALESCE(
  (SELECT MAX(occurred_at) FROM lead_timeline_items WHERE lead_id = l.id),
  l.created_at
);
```

## Edge cases considered

| Case | Behavior |
|---|---|
| Sync runs, no new messages | `last_activity_at` unchanged (was: bumped to now) |
| New inbound email arrives via webhook | Projector inserts timeline row → trigger updates `last_activity_at` to the email's `occurred_at` |
| Outbound send (Gmail/Outlook/SMS/WhatsApp) | Send code's optimistic `now()` update is correct (event is happening now); trigger reconciles when timeline row lands |
| Historical email backfill via `gmail-bulk-sync` | Multiple rows insert; trigger picks the latest `occurred_at`, never moves backwards |
| Call / meeting / note added | Same — trigger updates from the timeline insert |
| Manual user note via `TimelineTab` | Already passes a real `occurred_at`; trigger handles correctly |
| Clock-skew / bad row with future timestamp | 5-min ceiling rejects it |
| Lead with no timeline items yet (just imported) | `last_activity_at` stays at whatever the import set (usually `created_at`) |
| Hidden / soft-deleted timeline rows | Trigger fires anyway; if we want to exclude `hidden=true`, add `AND (NEW.metadata_json->>'hidden')::bool IS NOT TRUE` |

## Files changed

- **New migration**: `supabase/migrations/<ts>_last_activity_at_from_timeline.sql`
  - Trigger function + trigger on `lead_timeline_items`
  - One-time backfill `UPDATE`
- **`supabase/functions/_shared/syncEngine.ts`** — replace line 647 with conditional max-of-metrics
- *(optional cleanup, not required for the fix)*: remove hardcoded `last_activity_at: new Date().toISOString()` in `outlook-webhook` etc. and rely on the trigger. Leaving them is harmless because `GREATEST` protects against regressions, so I'd leave them for now to keep this PR small.

## Out of scope

- Not changing how `last_inbound_at` / `last_outbound_at` are derived — those are channel-specific and already correct.
- Not changing the dashboard UI formatting (`formatDistanceToNow` etc.) — fix is upstream.
- Not touching `interactions` (legacy, being retired per CLAUDE.md).

## Why a trigger rather than just fixing callers

There are 25+ writers that touch `last_activity_at`. A trigger guarantees correctness even if a future code path forgets — and `GREATEST` means no caller can ever silently move the field backwards. Aligns with how `lead_timeline_items` is already the canonical comms ledger.
