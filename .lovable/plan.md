## Problem

After a rep clicks Skip / Sent it / Done on an Outreach card, the next step in the cadence doesn't show up in the Queue until the 5-minute `campaign-touch-scheduler` cron fires.

## Root cause

`advanceColdEnrollment` (`supabase/functions/_shared/coldOutreach.ts`) does three things on completion:
1. Marks the completed touch `sent` / `skipped`.
2. Re-anchors the NEXT touch's `eligible_at` (delay_days = 0 → essentially "now", snapped to send window).
3. Advances the enrollment cursor and sets `campaign_enrollment.status = 'active'`.

What it does NOT do: flip the next touch's `campaign_touch.status` from `'scheduled'` to `'queued'`.

But `fetchOutreachQueue` (`src/lib/outreachQueue.ts`) only surfaces touches with `status = 'queued' AND eligible_at <= now`. So even though the next touch is due immediately, the Outreach tab is blind to it until `campaign-touch-scheduler` cron promotes scheduled→queued (every 5 min).

`promoteFirstDueTouches` in `src/lib/campaignEnrollment.ts` already solved this exact problem for **step 1** at enrollment time — we just never applied the same trick on subsequent advances.

## Fix (minimal, server-side, mirrors existing logic)

In `supabase/functions/_shared/coldOutreach.ts`, extend `advanceColdEnrollment` so that after re-anchoring the next touch and advancing the cursor, if the next touch is **due now** we promote it scheduled → queued inline, using the same gating rules `promoteFirstDueTouches` uses:

- If `nextEligible > now` → leave `scheduled` (staggered start, cron handles it later).
- If `next.channel === 'email'` AND campaign `send_mode = 'automatic'` AND workspace `auto_send_enabled` AND has timezone AND has postal address → leave `scheduled` (executor owns it). Otherwise promote to `queued` (review-mode email card).
- If `next.channel` is a manual channel (voice/sms/whatsapp/linkedin) AND the lead has the required handle (phone / whatsapp_number || phone / linkedin_url) → promote to `queued`. Otherwise leave `scheduled` and let `campaign-touch-scheduler`'s auto-skip+advance path handle the missing-handle case (don't duplicate the skip logic here — keeps one source of truth for "lead can't receive this channel").
- Also guard the promote with `.eq('status', 'scheduled')` so we never clobber a cron race.

Lead handle check uses a small `leads` lookup by `touch.lead_id` (id, phone, whatsapp_number, linkedin_url, unsubscribed); also bail if `unsubscribed`.

No schema changes. No client changes. No new RPC. No change to the cron — it stays as a safety net for staggered/late touches.

## Result

When a rep skips/completes a touch on a same-day cadence (delay_days = 0 or already past due), the next manual touch or review email shows up in the Outreach tab immediately on the next render. No 5-minute wait.

## Files touched

- `supabase/functions/_shared/coldOutreach.ts` — extend `advanceColdEnrollment` with the inline promote-next block; redeploy `outreach-touch-action` and `automation-executor` (both import the shared function).
