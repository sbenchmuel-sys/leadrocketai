

## Analysis: Why Dor Guzman Appears in "Action Required"

### Root Cause

The revenue state classification logic in `classifyRevenueState` (dashboardUtils.ts, lines 202-208) has a blanket rule:

> If `last_inbound_at > last_outbound_at` AND `has_future_meeting === false` → mark as **action_required**

For Dor Guzman:
- **last_inbound_at**: 2026-03-02 10:49:43 ("See you on Wednesday")
- **last_outbound_at**: 2026-03-02 10:37:46
- **has_future_meeting**: `false`

The inbound came 12 minutes after the outbound, so the system treats it as an "unreplied inbound" needing action. But the email is a **meeting confirmation** — it doesn't need a reply.

There's also a calendar acceptance interaction (`Accepted: Intro: Binah.ai and Dor Guzman`) at 10:46:28, but the sync pipeline didn't set `has_future_meeting = true`.

### Two Problems to Fix

1. **Gmail sync doesn't detect calendar acceptances** — The calendar accept email ("Accepted: ...") should set `has_future_meeting = true` on the lead, which would suppress the action_required state (the existing guard on line 204 already checks `!lead.has_future_meeting`).

2. **No "meeting confirmed" intent detection** — Emails like "see you on Wednesday/Thursday" are clear meeting confirmations that don't require a reply. The sync pipeline should detect these and either set `has_future_meeting = true` or mark the lead as not needing action.

### Proposed Fix

#### 1. Add meeting confirmation detection to `oooDetection.ts` (or a new shared util)

Create a `detectMeetingConfirmation` function with patterns:
- `see you on <day/date>`
- `looking forward to <day/date>`
- `confirmed for <day/date>`
- Subject containing `Accepted:` (calendar acceptance)

When detected:
- Set `has_future_meeting = true` on the lead
- Insert a `system_note` interaction: "📅 Meeting confirmed — see you on Wednesday"
- Do NOT set `needs_action = true`

#### 2. Integrate into gmail-sync, gmail-bulk-sync, outlook-sync, outlook-webhook

After processing inbound emails, run `detectMeetingConfirmation` on the email body and subject. If positive, update the lead's `has_future_meeting` flag.

#### 3. Calendar acceptance subject detection

In the sync pipelines, detect subjects matching `Accepted:` or `Accepted:.*` patterns. These are calendar confirmations and should automatically set `has_future_meeting = true` on the matched lead.

### Technical Details

**Detection patterns** (regex):
```text
/\bsee you (?:on |this |next )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}[\/\-]\d{1,2})/i
/\blooking forward to (?:our |the )?(?:meeting|call|chat|discussion|session)/i
/\bconfirmed? (?:for|on) /i
Subject: /^Accepted:/i
```

**Lead update** when confirmed:
```sql
UPDATE leads SET has_future_meeting = true WHERE id = $lead_id;
```

**No changes needed to `classifyRevenueState`** — the existing `!lead.has_future_meeting` guard on line 204 will correctly suppress action_required once the flag is set.

