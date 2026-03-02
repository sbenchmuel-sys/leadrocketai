

## Analysis: Hallucinated Follow-up Email for Siddhesh Malvankar

### Root Cause

The AI generated a response based on **Siddhesh's January 30 email** (requesting reschedule to 11:30 AM IST on Feb 3rd, with additional team members joining) rather than responding to **your most recent outbound on February 23**.

The hallucination traces to a **staleness guard** in `generateDraft.ts` (lines 182-189) combined with the **task selection logic**:

#### Problem 1: Wrong task selected — `post_meeting_followup_email` instead of `pre_email_X_followup`

The lead's motion is `post_meeting` and the playbook resolver likely selected `post_meeting_followup_email`. This task's prompt says:

> "Generate a personalized follow-up email based on the meeting and FULL email thread context"

Since the last **inbound** email (Jan 30) contains the reschedule request and questions about accuracy/FDA/GDPR, the AI treated it as the context to respond to — producing a reply to that old January email instead of writing a follow-up to your February 23 outbound.

#### Problem 2: Stale inbound treated as current context

The staleness guard in `generateDraft.ts` works correctly for `reply_to_thread` (it checks if inbound is newer than outbound), but for `post_meeting_followup_email`, the prompt template uses `{{PREVIOUS_EMAILS}}` and `{{LAST_OUTBOUND}}` — and the **thread_summary** includes ALL emails chronologically, with the January 30 inbound prominently featured.

The AI sees:
- **Last inbound**: Jan 30 — "reschedule to 11:30 AM IST, additional members joining"
- **Last outbound**: Feb 23 — "checking in on POC use case"
- **Motion**: `post_meeting`

The `post_meeting_followup_email` prompt tells it to check if materials were already shared. Since the Feb 23 email mentions "review the materials we shared," the AI conflates the Jan 30 reschedule request with a live conversation, producing a reply that references rescheduling to 11:30 AM and "additional team members."

#### Problem 3: Date mismatch — "February 3rd" in generated email

The AI pulled the date "February 3rd" directly from Siddhesh's January 30 email ("I have scheduled the meeting for 3rd February 2026"). Since no date awareness is injected into the prompt, the AI doesn't know it's now March 2, making "February 3rd" look current.

### Fix Plan

#### 1. Inject current date into AI task system prompt

Add `Current date: ${new Date().toISOString().split('T')[0]}` to the system prompt in `ai_task/index.ts`. This gives the LLM temporal awareness to avoid referencing past dates as if they're upcoming.

#### 2. Add staleness guard to `post_meeting_followup_email` payload

In `generateDraft.ts`, when building the payload for `post_meeting_followup_email`, apply the same staleness check used for `reply_to_thread`: if the last inbound is older than the last outbound, mark it as stale context so the AI doesn't try to "respond" to it.

```typescript
// In buildAIPayload, for post_meeting_followup_email:
if (taskType === "post_meeting_followup_email") {
  // ... existing code ...
  // Add staleness marker
  const inboundTime = ctx.last_inbound_email?.occurred_at;
  const outboundTime = ctx.last_outbound_email?.occurred_at;
  if (inboundTime && outboundTime && new Date(outboundTime) > new Date(inboundTime)) {
    payload.stale_inbound = true;
  }
}
```

#### 3. Update `post_meeting_followup_email` prompt to respect staleness

Add a rule to the prompt: "If the most recent interaction is an OUTBOUND email (not inbound), do NOT write a reply to the last inbound. Instead, write a follow-up to YOUR last outbound."

#### 4. Add date context to thread summary

Modify the thread summary builder to include relative timestamps (e.g., "31 days ago" vs "7 days ago") so the AI can distinguish recent from stale context.

### Files to Change

- `supabase/functions/ai_task/index.ts` — Add current date to system prompt; update `post_meeting_followup_email` prompt with staleness rules
- `src/lib/generateDraft.ts` — Add staleness marker for `post_meeting_followup_email` payload; add relative dates to thread summary
- `src/lib/contextResolver.ts` — Optionally annotate thread emails with age indicators

