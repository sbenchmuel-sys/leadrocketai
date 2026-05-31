# Fix: "AI returned an invalid recap format" on Add & Analyze

## Root cause

`ai_task` calls Gemini 2.5 Pro for `post_meeting_recap` with `max_tokens: 2048`. Pro burns a large share of that budget on internal reasoning tokens, so the JSON recap (recap bullets + milestones + risks + action items + open questions + full follow-up email) gets truncated mid-string. The client then fails `JSON.parse` and surfaces "AI returned an invalid recap format".

The same risk applies to the other JSON-heavy analysis tasks that share the Pro model: `extract_milestones_risks`, `extract_deal_factors`, `recommend_next_steps`, `lead_deep_analysis`, `post_meeting_followup_personalized`.

## Changes

### 1. `supabase/functions/ai_task/index.ts` — give analysis tasks real headroom

Add per-task `max_tokens` overrides in `TASK_MAX_TOKENS` (around line 1007):

```
post_meeting_recap: 8192,
extract_milestones_risks: 4096,
extract_deal_factors: 4096,
recommend_next_steps: 4096,
lead_deep_analysis: 8192,
post_meeting_followup_personalized: 6144,
```

These already use `gemini-2.5-pro`; the override only widens the cap so reasoning + JSON both fit. Output is still bounded.

### 2. `supabase/functions/ai_task/index.ts` — surface truncation instead of returning silently-broken content

In the post-`fetch` block around line 2050, when `finish_reason === "length"` for an `ANALYSIS_TASKS` task, log it explicitly and (a) retry once with the same model at a higher cap if we haven't already, or (b) return `{ ok: false, error: "Recap output was truncated — please retry" }` so the UI shows a clearer message than "invalid format". Keeps existing empty-content fallback intact.

### 3. `src/components/lead/MeetingsTab.tsx` — defensive JSON parsing

In both `handleAddMeetingSummary` (line 149–155) and `regenerateRecapForPack` (line 228–232):

- Keep current `extractJson` + `JSON.parse`.
- On parse failure, attempt one repair pass: if the stripped content starts with `{` but doesn't end with `}`, trim to the last balanced `}` and retry parse. If still failing, fall back to current error toast.
- Log the first 300 chars of `recapResult.content` plus the error so future regressions are diagnosable from the browser console.

This is a safety net; the real fix is #1.

### 4. No schema changes, no migrations.

## Verification

1. Open the same lead (`Hungdq`), paste the same Zoom Quick recap, click Add & Analyze.
2. Confirm the recap saves: `internal_recap_bullets`, `open_questions`, `customer_email.subject` and `customer_email.body` all populated on the resulting meeting pack.
3. Tail `ai_task` logs and confirm no `finish_reason=length` for the `post_meeting_recap` call.
4. Repeat with `regenerateRecapForPack` (Regenerate button on an existing pack) to cover both code paths.

## Out of scope

- Switching `post_meeting_recap` off the Pro model (would change recap quality; not requested).
- Adding `response_format: { type: "json_object" }` (Gemini support is inconsistent across tasks here; a separate change once we validate it doesn't regress other Pro tasks).
- Migrating the recap call to the central `meeting-transcript-analyze` edge function (separate refactor).
