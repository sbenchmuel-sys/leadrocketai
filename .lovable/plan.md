## Analysis

**What's happening on your timeline:**
- 997 inbound email timeline rows. Only **29** carry a real AI-generated summary (refetched body + intent_router v2 prompt). The rest are either older rows missing a summary entirely or "subject_fallback" synth lines like the one in your screenshot ("Original message body no longer retained — summary derived from metadata").
- 762 of 850 inbound `interactions` rows have `body_text = NULL` (purged).
- **918** inbound timeline rows are still pending processing under the current backfill version (`inbound_summary/v4`).

**Why backfill hasn't drained:**
- `backfill-inbound-summaries` is batched at 50 rows per invocation. To clear 918 rows it needs ~19 invocations. It was not being driven in a loop.
- For Outlook rows, the RFC822 `internetMessageId` is stored correctly (`<...@...outlook.com>`), so refetch *can* succeed when the workspace's Outlook token is valid and the message still exists in the mailbox. Rows that ended in subject_fallback either ran before the token was refreshed or the Graph `$filter` returned no match (deleted / archived / different mailbox).
- For Gmail rows, refetch needs the lead's owner to still have a valid `gmail_connections` row. Same idea: where the token is alive and the message still exists, we get a full v2 bullet summary.

**Why the purge is still a risk:**
- `message-cleanup` edge function runs hourly via cron and delegates to the SQL function `expire_old_messages()`, which is *also* scheduled hourly as a DB-level fallback (per `CLAUDE.md`). So purge is currently still active — even though you stopped trusting it, it has not been turned off.

**Bullet summaries:**
- `intent_router` already produces bullet-form `ai_summary` (MULTI-POINT shape) and `SummaryBody.tsx` renders bullets. You're not seeing bullets only because the source body is gone *and* the backfill synth fallback is one paragraph by design. Where refetch succeeds, bullets appear automatically.

## Plan

### 1. Disable the purge (both paths)
- Migration to **unschedule** both pg_cron jobs that drive purge:
  - the cron entry that calls `message-cleanup` edge function
  - the DB-level cron entry that calls `expire_old_messages()` directly
- The codified `*_codify_cron_jobs.sql` will be updated in the same migration so the live state and the audit mirror stay in sync (per project convention).
- Leave the edge function and SQL function in place (no code deletion) so re-enabling later is a one-line cron schedule restoration.

### 2. Backfill loop driver
Add a new internal edge function `backfill-inbound-drain` that:
- Calls `backfill-inbound-summaries` in a loop until `fetched: 0` (or a safety cap of N invocations / minutes).
- Logs per-batch counts (`body_present`, `gmail_refetched`, `outlook_refetched`, `subject_synth`, `failed`).
- Authenticated via `X-Internal-Secret` only.
- Optional `?workspace_id=<uuid>` pass-through.

This is one shot — once drained you do not need to run it again. Existing `backfill-inbound-summaries` logic is unchanged.

### 3. Improve refetch coverage for Outlook
The current `fetchOutlookBody` only looks up by `internetMessageId` via `$filter`. For rows where that returns empty but `provider_message_id` (Graph immutable ID) is stored, add a second attempt: `GET /me/messages/{provider_message_id}` directly. This is cheaper and works even when the message has moved folders. Falls through to the existing subject synth on miss. No-op for rows where the IDs are equal (which is most of your dataset).

### 4. Trigger the drain
Once steps 1–3 are deployed, invoke `backfill-inbound-drain` once. Expected outcome:
- Inbound rows with live tokens + still-present source emails → real v2 bullet summaries replace the synth.
- Inbound rows with revoked tokens / deleted messages → stay on the multi-line subject synth (terminal — body is permanently gone from the source mailbox too).
- Status report returned to you: how many were upgraded, how many remain terminal synth.

### 5. Verification
- Re-check the Andy Ko thread in the screenshot — if the message still exists in your Outlook mailbox you'll see a bullet summary; if not, the synth stays.
- Confirm cron job count drops by 2 in `cron.job`.
- Spot-check `lead_timeline_items` for `ai_summary_source IS NULL AND ai_summary_version = 'inbound_summary/v4'` — these are the "real" summaries.

## Out of scope
- No changes to `intent_router` prompt (already produces bullets when content warrants).
- No changes to `SummaryBody` rendering (already renders bullets).
- No re-enable of purge — that stays your call, separately.
- No backfill of `interactions.body_text` — bodies that were purged from our DB and deleted from the source mailbox cannot be recovered. The AI summary on the timeline row is the durable artifact going forward.

## Technical notes

Files affected:
- `supabase/migrations/<new>_disable_purge_crons.sql` — `cron.unschedule(...)` for both jobs; updated codify mirror.
- `supabase/functions/backfill-inbound-drain/index.ts` — new loop driver.
- `supabase/functions/backfill-inbound-summaries/index.ts` — add Outlook fallback lookup by `provider_message_id`. Bump `AI_SUMMARY_VERSION` to `inbound_summary/v5` so prior v4 subject_fallback rows get one re-attempt with the new Outlook path.

Drain ETA: ~3–5 minutes for 918 rows (50/batch, AI call per refetched row).
