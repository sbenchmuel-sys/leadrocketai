## What I found

The problem is real and data-side, not just UI:

- The example lead has 4 timeline rows, but **0 rows with body text** and **0 rows with durable AI summaries**.
- The hourly cleanup jobs are still active and have already nulled `snippet_text` / `body_text`.
- The inbound classifier is running every minute, but it is repeatedly failing to parse AI JSON wrapped in markdown fences, so rows stay without `intent` and without `metadata_json.ai_summary`.
- Queue and Lead Detail both read from `lead_timeline_items`; once `snippet_text` is purged and no `ai_summary` exists, the UI and `ai_task` only see subject/header-level data. That is why drafts are invented.

## Fast recovery plan

1. **Stop the bleeding immediately**
   - Temporarily disable both message cleanup cron jobs:
     - `dispatch-message-cleanup`
     - `expire-messages-direct`
   - This prevents more raw email bodies/snippets from being wiped while we backfill.

2. **Fix classifier parsing so durable summaries actually get written**
   - Update `classify-inbound` JSON extraction to strip markdown fences and recover partial fenced JSON safely.
   - Keep the existing guardrail: substantive intents must include `ai_summary`, otherwise retry.
   - Deploy `classify-inbound` after the fix.

3. **Make future syncs retain enough visible context**
   - Keep writing raw body into `interactions.body_text` and `lead_timeline_items.snippet_text` during Gmail sync.
   - Ensure the classifier has a chance to summarize before any future cleanup is re-enabled.

4. **Backfill missing history from Gmail**
   - Run the existing Gmail sync/bulk sync path after cleanup is paused.
   - Important: because existing rows are deduped by Gmail message ID, the current duplicate path may only re-project timeline rows and may not restore purged bodies. I’ll adjust the duplicate path so when Gmail re-fetches the same message, it can refill empty `interactions.body_text` and `lead_timeline_items.snippet_text` for that Gmail message.

5. **Backfill durable summaries after bodies are restored**
   - Re-run `classify-inbound` over restored inbound rows.
   - Confirm counts improve:
     - `snippet_text` present again for recent/backfilled rows
     - `metadata_json.ai_summary` present for substantive inbound rows
     - Queue cards show preview/recap
     - Lead Detail timeline shows message history
     - `build-lead-context` has real prior interaction context

6. **Only then decide whether to re-enable cleanup**
   - For pilot safety, leave cleanup disabled until you explicitly say to turn it back on.
   - Later, re-enable with a safer rule: do not purge email bodies/snippets unless a durable `ai_summary` exists, with a longer hard cap if needed.

## Technical changes

- Database migration:
  - mark the two cleanup cron jobs inactive.
- Edge function changes:
  - `supabase/functions/classify-inbound/index.ts`: robust JSON extraction for fenced AI output.
  - `supabase/functions/_shared/canonicalInteraction.ts`: duplicate-message recovery that refills missing body/snippet data when Gmail re-sync sees the same Gmail message.
- Deploy changed edge functions:
  - `classify-inbound`
  - `gmail-sync`
  - `gmail-bulk-sync` if shared helper deployment requires it.

## Validation

- Query the current lead before/after to confirm body/snippet/summary counts recover.
- Check `classify-inbound` logs no longer show repeated `ai_parse_failed` for fenced JSON.
- Open the lead and Queue again to verify history and previews are visible.