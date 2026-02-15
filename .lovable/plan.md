

## Fix: Post-Breakup Re-engagement Generating Wrong Email Type

### Problem

When the outbound sequence completes (breakup email sent) and the lead hasn't replied, clicking "Generate Draft" produces a nonsensical reply that addresses the lead's OLD inbound message as if they just responded (e.g., "Thanks for getting back to me, Manoj").

### Root Cause

The playbook resolver's `deriveDefault` function (Rule 6) recommends `reply_to_thread` for any inbound-sourced lead (`contact_form`, `gmail_inbound`, `referral`) that has an email thread -- without checking whether the latest inbound is actually newer than the latest outbound. After a breakup email, the thread exists, the old inbound exists, so the system picks `reply_to_thread`. The AI then receives the stale inbound as `LATEST_INBOUND` and writes a reply to it.

### Solution

Two changes fix this:

**1. Fix `deriveDefault` in playbook resolver** (`src/lib/playbookResolver.ts`)

For inbound-sourced leads with a thread, check whether the most recent inbound is actually newer than the most recent outbound before recommending `reply_to_thread`. If the outbound is newer (meaning the rep already replied and is waiting), fall through to the outbound follow-up logic instead.

This requires passing `ResolvedContext` into `deriveDefault` (it currently only uses a subset of fields). The function will compare `last_inbound_email.occurred_at` vs `last_outbound_email.occurred_at` and only recommend `reply_to_thread` when the inbound is genuinely the most recent message.

When the outbound is newer (post-breakup or post-follow-up state), use a re-engagement intro (`pre_email_1_intro`) to generate a fresh approach rather than replying to a stale message.

**2. Add a safety check in `buildAIPayload`** (`src/lib/generateDraft.ts`)

When the task is `reply_to_thread`, verify that `latest_inbound` is actually a recent message (newer than last outbound). If it's stale, clear the `latest_inbound` field so the AI doesn't hallucinate a response to an old message.

### Technical Details

**File: `src/lib/playbookResolver.ts`**

Update `deriveDefault` to accept full context and add inbound-freshness check:

```text
Before:
  if (source is inbound AND hasThread) -> reply_to_thread

After:
  if (source is inbound AND hasThread) {
    if (last_inbound is newer than last_outbound) -> reply_to_thread
    else -> pre_email_1_intro (re-engagement)
  }
```

**File: `src/lib/generateDraft.ts`**

In `buildAIPayload`, for `reply_to_thread`, add a staleness guard:

```text
if (taskType === "reply_to_thread") {
  // Only include latest_inbound if it's genuinely newer than last outbound
  const inboundTime = ctx.last_inbound_email?.occurred_at;
  const outboundTime = ctx.last_outbound_email?.occurred_at;
  if (inboundTime && outboundTime && new Date(inboundTime) > new Date(outboundTime)) {
    payload.latest_inbound = ctx.last_inbound_email?.body_text || "";
  } else {
    payload.latest_inbound = "";  // prevent AI from addressing stale inbound
  }
}
```

### Files Modified

| File | Change |
|------|--------|
| `src/lib/playbookResolver.ts` | Update `deriveDefault` to check inbound freshness before recommending `reply_to_thread`; fall back to re-engagement intro when outbound is newer |
| `src/lib/generateDraft.ts` | Add staleness guard for `latest_inbound` in `buildAIPayload` to prevent AI from replying to old messages |

