
# Smarter Follow-Up Emails: Context-Aware Re-engagement

## Problem Summary

When generating a follow-up email for a lead who hasn't responded (like Dali Sattarov), the AI produces nearly the same email as the last one sent. This happens because:

1. **Insufficient context passed to AI**: The follow-up prompt (`pre_email_2_followup`, `pre_email_3_followup`) only receives a `thread_summary` (truncated to 500 chars per email) and generic lead metadata. It does NOT receive milestones, risks, buying signals, engagement data, or the full last outbound email body.

2. **No "last email" display in composer**: The composer shows the most recent email in the thread, but if the most recent is outbound (which it is when the lead hasn't replied), it shows it correctly. However, the `body_text` field may be truncated or missing depending on how it was stored.

3. **Follow-up prompts lack differentiation instructions**: The `pre_email_2_followup` prompt says "add one value point" but doesn't receive enough context (milestones, meeting notes, signals) to find a genuinely different angle.

## Changes

### 1. Enrich follow-up payload with re-engagement context (`src/lib/generateDraft.ts`)

In `buildAIPayload`, when the task is a follow-up (`pre_email_2_followup`, `pre_email_3_followup`, `pre_email_4_breakup`):

- Pass the **full body of the last outbound email** as `last_outbound_body` so the AI knows exactly what was already said
- Pass **buying signals** and **risk signals** from the resolved context
- Pass **milestones** (completed + pending) so the AI can reference deal progress
- Pass **engagement level** and **days since last activity** for urgency calibration
- Pass **meeting summaries** if any exist, to draw from real conversation content

### 2. Update follow-up prompts in edge function (`supabase/functions/ai_task/index.ts`)

Update `pre_email_2_followup` and `pre_email_3_followup` prompts to:

- Accept new template variables: `{{LAST_OUTBOUND_BODY}}`, `{{BUYING_SIGNALS}}`, `{{RISK_SIGNALS}}`, `{{MILESTONES}}`, `{{ENGAGEMENT_LEVEL}}`, `{{DAYS_SINCE_ACTIVITY}}`
- Add explicit instructions: "Do NOT repeat the same angle, value proposition, or CTA from the last outbound email"
- Add re-engagement angle suggestions based on available context:
  - If milestones exist: reference a completed milestone or pending one
  - If meeting summaries exist: callback to a discussion point
  - If buying signals detected: lean into the signal
  - If no signals: try a different value angle (industry insight, case study, peer comparison)

### 3. Ensure full last email is visible in composer (`src/components/dashboard/EmailActionDialog.tsx`)

The composer already shows `mostRecentEmail.body_text` without truncation (line 910: "FULL email body - never truncated"). If the body appears incomplete, the issue is likely that `body_text` was stored truncated in the database during sync. No code change needed here -- but we should verify the data.

However, we will add a visual enhancement: when the most recent email is **outbound** (i.e., your last sent email), add a subtle "days ago" indicator and a label like "Sent 10 days ago -- no reply" to make the staleness visually obvious.

## Technical Details

### File: `src/lib/generateDraft.ts` -- `buildAIPayload` function

Add after the existing `previous_email_summary` block (around line 148):

```typescript
if (taskType.includes("pre_email")) {
  payload.previous_email_summary = ctx.thread_summary || "No previous emails sent yet.";
  // NEW: Full last outbound for dedup
  payload.last_outbound_body = ctx.last_outbound_email?.body_text || "";
  // NEW: Intelligence signals for varied angles
  payload.buying_signals = ctx.buying_signals.length > 0 
    ? ctx.buying_signals.join(", ") : "None detected";
  payload.risk_signals = ctx.risk_signals.length > 0 
    ? ctx.risk_signals.join(", ") : "None detected";
  payload.engagement_level = ctx.engagement_level;
  // Milestones summary
  const milestones = ctx.lead.milestones_json as any[];
  payload.milestones = milestones?.length > 0
    ? milestones.map(m => `${m.status}: ${m.description}`).join("; ")
    : "No milestones recorded";
  // Days since last activity
  if (ctx.lead.last_activity_at) {
    const days = Math.floor((Date.now() - new Date(ctx.lead.last_activity_at).getTime()) / (1000*60*60*24));
    payload.days_since_activity = String(days);
  }
  // Meeting context if available
  if (ctx.last_meeting_summary) {
    const bullets = ctx.last_meeting_summary.internal_recap_bullets;
    payload.meeting_context = Array.isArray(bullets) 
      ? (bullets as string[]).slice(0, 3).join(". ") : "";
  }
}
```

### File: `supabase/functions/ai_task/index.ts` -- Update prompts

**`pre_email_2_followup`** prompt updated to include:

```
CRITICAL DEDUPLICATION:
Your last email said:
{{LAST_OUTBOUND_BODY}}

Do NOT repeat the same:
- Opening angle or observation
- Value proposition or benefit
- CTA phrasing
- Company/product description

Instead, choose ONE fresh re-engagement angle from:
1. Reference a milestone or deal progress point: {{MILESTONES}}
2. Address a detected buying signal: {{BUYING_SIGNALS}}
3. Share a relevant industry insight or peer example
4. Reference a meeting discussion point: {{MEETING_CONTEXT}}
5. Acknowledge the silence directly with a binary question

Engagement: {{ENGAGEMENT_LEVEL}} | Days inactive: {{DAYS_SINCE_ACTIVITY}}
```

Similar update for `pre_email_3_followup` with more direct tone.

### File: `src/components/dashboard/EmailActionDialog.tsx` -- Staleness indicator

When `mostRecentEmail.direction === 'outbound'`, show days-since and "no reply" label:

```typescript
// After the Badge showing "Sent", add:
{mostRecentEmail.direction === 'outbound' && (() => {
  const days = Math.floor((Date.now() - new Date(mostRecentEmail.occurred_at).getTime()) / (1000*60*60*24));
  return days > 3 ? (
    <Badge variant="destructive" className="text-xs">
      No reply in {days} days
    </Badge>
  ) : null;
})()}
```

## Summary of Files Changed

| File | Change |
|------|--------|
| `src/lib/generateDraft.ts` | Pass full last outbound, signals, milestones, engagement to follow-up payloads |
| `supabase/functions/ai_task/index.ts` | Update follow-up prompts with dedup rules and re-engagement angle selection |
| `src/components/dashboard/EmailActionDialog.tsx` | Add "No reply in X days" badge for stale outbound emails |
