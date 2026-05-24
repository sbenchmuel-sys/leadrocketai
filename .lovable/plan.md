## Problem

149/149 recent inbound rows are classified but have no `ai_summary` (v1 classifier never wrote it). The 72h purge already wiped `snippet_text` + `interactions.body_text`, so Queue cards show "[No preview available]" with only a subject if any. New inbounds will be fine going forward (v2 writes ai_summary atomically), but the visible backlog looks bad to pilots.

## Plan

### 1. Extend inbound retention from 72h → 7 days (migration)

Change `public.expire_old_messages()`:
- **`lead_timeline_items.snippet_text`**: for `event_type='email_inbound'` rows, gate stays "intent IS NOT NULL OR 7d hard cap" — but the early-purge "intent IS NOT NULL" path now also requires `metadata_json->>'ai_summary' IS NOT NULL`. So a classified-but-unsummarized row waits the full 7 days instead of being purged at 72h.
- **`interactions.body_text`**: same change — inbound rows require the paired timeline row's `ai_summary` to exist before early-purge; otherwise wait 7 days.
- **Outbound + non-inbound event types: unchanged** (72h unconditional). Outbound has no preview problem.
- `messages.body_ciphertext` (WhatsApp/SMS): unchanged (72h unconditional, no classifier path).

This both stops the bleeding AND gives the backfill job a working window.

### 2. New edge function: `backfill-inbound-summaries`

Single-shot, idempotent, runnable on-demand:

1. Select rows from `lead_timeline_items` where `event_type='email_inbound'` AND `metadata_json->>'ai_summary' IS NULL` AND `occurred_at > now() - interval '14 days'`, joined to `interactions` for body access. Batch of 50.
2. For each row, in order of preference:
   - **(a) Body still present** (`interactions.body_text` or `snippet_text` not null): run the existing v2 classifier prompt, write `ai_summary` back into `metadata_json`. Also restore `snippet_text` from the body if it was nulled.
   - **(b) Body purged but `gmail_message_id` / Outlook ID present**: use the lead's owner_user_id → look up the connected mail account → refetch the message via Gmail/Outlook API (reusing existing `GmailProvider` / `OutlookProvider` token-decrypt + fetch paths). Classify. Write `ai_summary` AND restore `snippet_text` (it'll re-purge naturally at the new 7-day boundary, which is fine — by then we have ai_summary).
   - **(c) Refetch fails (token revoked, message deleted, 404)**: synthesize a degraded summary from subject + sender name + workspace context, e.g. `"Reply from {sender_name} ({company}) — subject: {subject}"`. Mark with a small `metadata_json.ai_summary_source = 'subject_fallback'` flag so we can audit later.
3. Returns `{ processed, refetched, fallback_synth, failed }`.

No cron schedule — runs once manually. If results are good, run again with widened window if needed.

### 3. UI: no changes

`cleanBodyText.ts` already prefers `ai_summary` → `snippet_text` → `subject`, and the Queue card already calls it. Once `ai_summary` is populated, "[No preview available]" disappears.

## Technical details

**Files to add:**
- `supabase/migrations/<ts>_extend_inbound_purge_window.sql` — replaces `expire_old_messages()` with the gated inbound branch.
- `supabase/functions/backfill-inbound-summaries/index.ts` — backfill worker.

**Files to touch:**
- `supabase/functions/_shared/mailProviders/` or wherever Gmail/Outlook fetch-by-id helpers live — reuse, don't duplicate. If a single-message fetch helper doesn't exist server-side I'll add a thin `getMessageById(provider, messageId)` shared util.
- `CLAUDE.md` — update the "72h" wording in the Public product commitments section to reflect the inbound 7-day extension.
- `mem://logic/message-retention-policy` — update to reflect the new inbound branch.

**Invocation:**
After deploy I'll call `backfill-inbound-summaries` via `supabase--curl_edge_functions` in batches until `processed=0`, then report counts (refetched vs synth vs failed).

**Reversibility:**
The purge function change is a pure SQL replacement — easy to revert. The backfill only writes into `metadata_json.ai_summary` (and optionally `snippet_text`), which the existing purge will manage going forward.

## Out of scope

- Changing 72h for `messages` (WhatsApp/SMS) — those don't have the preview issue.
- Permanent retention extension beyond the resolution window — once v2 classifier coverage is proven on a full retention cycle, we revisit returning to 72h.
- Backfilling rows older than 14 days — bodies are long gone and ROI is low.
