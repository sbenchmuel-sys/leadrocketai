## Problems

**1. Only "Skip" on Call & LinkedIn touches** — no way to snooze (defer to later) and the wording "Skip" feels destructive. Reps want the same **Mark as handled** + **Snooze 3/5/7 days** pattern they already use in the Replied / Follow up tabs.

**2. Content is invisible before acting** — on a Call touch the talking points only appear *after* the rep clicks Call; on a LinkedIn touch the message/note the rep is supposed to paste is never shown on the card at all. The rep has to trust the clipboard blindly.

---

## Fix

### A. OutreachCard action row — align with QueueCard

Replace the lone "Skip" ghost link with the same two-button pattern used in the other Queue tabs:

```text
[ primary channel action ]  [ Mark as handled ]  [ Snooze ▾ ]
                                                    ├ Snooze 3 days
                                                    ├ Snooze 5 days
                                                    └ Snooze 7 days
```

Semantics for outreach touches:
- **Mark as handled** → advances the cadence exactly like today's "Sent it" (calls existing `markTouchSent`). Used when the rep did the touch outside the app, or genuinely wants to move on. Same optimistic-remove + toast behavior.
- **Snooze N days** → pushes THIS touch's `eligible_at` forward by N days and keeps `status = 'queued'`, so it disappears from today's Outreach list and re-surfaces on day N. No cadence advance, no skip. Implemented as a new `snooze_touch` action in the existing `outreach-touch-action` edge function (single-line UPDATE, RLS already scopes by owner). One new client helper `snoozeTouch(touchId, days)` in `src/lib/outreachQueue.ts`.
- **Skip** stays available but demoted into the Snooze dropdown as "Skip this step" (destructive styling) — keeps the escape hatch without cluttering the row.

Post-call outcome buttons ("Got them / No answer" + "Sent it") are unchanged — they only appear after a call is actually placed, which is a separate flow.

### B. Show the content on the card, before the rep acts

Add a lightweight **preview block** inside the card body, above the action buttons. Content shown depends on channel:

- **Call**: talking points + voicemail script (labeled), always visible when present — not gated on "opened" like today.
- **LinkedIn**:
  - `connect` → labeled "Connection note" — shows `body`.
  - `message` → labeled "Message to paste" — shows `body`.
  - `react` → shows a one-line hint ("Open profile and react to their latest post — no message needed").
- **SMS / WhatsApp**: shows the prefilled `smsText` (already deep-linked, but reps asked to see it).
- **Email**: unchanged — the review dialog already shows subject + body.

Preview styling: same muted small-text treatment already used for talking points (`whitespace-pre-wrap text-xs text-muted-foreground`), inside a subtle bordered box, capped at ~6 lines with a "Show more" toggle for long copy so the card doesn't grow unbounded. A small "Copy" icon button in the corner (reuses `copyToClipboard`) so the rep can re-copy if the auto-copy on Open didn't land.

### C. Nothing else changes

- Email review dialog, browser-call flow, LinkedIn deep-link + auto-copy, "No content / No profile" disabled states, and cadence advancement all keep working exactly as they do today.
- No changes to `campaign_touch` schema, no changes to the scheduler, no changes to `advanceColdEnrollment`.

---

## Technical bits

- `supabase/functions/outreach-touch-action/index.ts` — add `snooze_touch` action: verifies the row belongs to the caller's workspace (existing pattern), then `UPDATE campaign_touch SET eligible_at = now() + interval 'N days' WHERE id = $1 AND status = 'queued'` for N in {3,5,7}.
- `src/lib/outreachQueue.ts` — add `snoozeTouch(touchId, days)`.
- `src/components/queue/OutreachCard.tsx` — replace the action column with the QueueCard-style trio (channel action + Mark handled + Snooze dropdown), add the preview block above.
- No migration, no type regen (no new columns).

## Improvement ideas (optional, not in this PR unless you say yes)

1. **Undo toast on Mark as handled** — 5-second undo, mirrors what the Replied tab does. Prevents "oops, wrong button" from burning a cadence step.
2. **"Snooze until tomorrow morning"** as a fourth option — most common ask for call touches when the rep runs out of time in the day. Snaps to 9am workspace-local.
3. **Sticky preview on hover for the collapsed Upcoming touches strip** — same preview component, so managers/reps can sanity-check tomorrow's copy without expanding every row.

Say the word and I'll fold any of these in.