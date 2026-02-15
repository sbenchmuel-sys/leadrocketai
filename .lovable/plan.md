
## Fix: Re-engagement Email Should Use Lead Intelligence, Not Cold Intro

### Problem

The previous fix correctly identified that stale inbound leads shouldn't get `reply_to_thread`, but it falls back to `pre_email_1_intro` which is a **cold intro prompt** ("Cold Intro in an outbound prospecting cadence"). It generates a generic pitch ignoring all prior relationship context -- meetings held, email conversations, milestones extracted by AI analysis, and recommended next steps.

### Root Cause

`pre_email_1_intro` prompt template in the edge function:
- Says "Email 1 (Cold Intro)"
- Only uses `{{LEAD_CONTEXT}}`, `{{REP_CONTEXT}}`, `{{KNOWLEDGE_CONTEXT}}`
- Does NOT reference `{{MILESTONES}}`, `{{MEETING_CONTEXT}}`, `{{PREVIOUS_EMAIL_SUMMARY}}`, `{{BUYING_SIGNALS}}`, etc.
- Even though the payload builder sends milestones/meeting data for all `pre_email` tasks, the prompt template for step 1 never renders them

### Solution

Create a dedicated `re_engagement_intro` task type that is purpose-built for leads with existing relationship context. It will leverage milestones, meeting notes, buying signals, conversation history, and AI recommendations to craft a contextual re-engagement email -- not a cold pitch.

### Changes

**1. Add `re_engagement_intro` to AITaskType** (`src/hooks/useAITask.ts`)

Add the new type to the union.

**2. Update playbook resolver** (`src/lib/playbookResolver.ts`)

Change the fallback from `pre_email_1_intro` to `re_engagement_intro` when an inbound-sourced lead has a thread but outbound is newer (post-breakup/waiting state).

**3. Update payload builder** (`src/lib/generateDraft.ts`)

Add `re_engagement_intro` to the condition that populates rich context (milestones, meeting context, buying signals, risk signals, previous email summary, etc.). Currently this block checks `taskType.includes("pre_email")` -- it needs to also match `re_engagement_intro`.

Also include the AI-extracted recommendations (from `recommend_next_steps` analysis stored on the lead) so the prompt can reference them.

**4. Add new prompt template in edge function** (`supabase/functions/ai_task/index.ts`)

Create a `re_engagement_intro` prompt that:
- Acknowledges the existing relationship (not cold)
- References the most recent meeting or conversation context
- Uses milestones and AI recommendations to pick a fresh angle
- Keeps it concise (90-140 words) like follow-up emails
- Includes deduplication against the last outbound
- Uses the same greeting/sign-off conventions

The prompt will use these template variables:
- `{{LEAD_CONTEXT}}`, `{{REP_CONTEXT}}`, `{{KNOWLEDGE_CONTEXT}}`
- `{{PREVIOUS_EMAIL_SUMMARY}}`, `{{LAST_OUTBOUND_BODY}}`
- `{{MILESTONES}}`, `{{BUYING_SIGNALS}}`, `{{RISK_SIGNALS}}`
- `{{MEETING_CONTEXT}}`, `{{ENGAGEMENT_LEVEL}}`, `{{DAYS_SINCE_ACTIVITY}}`
- `{{MEETING_LINK}}`, `{{CUSTOM_INSTRUCTIONS}}`

**5. Register in edge function task routing** (`supabase/functions/ai_task/index.ts`)

Add `re_engagement_intro` to the `KNOWLEDGE_SEARCH_TASKS` array so it gets KB context.

### Technical Details

| File | Change |
|------|--------|
| `src/hooks/useAITask.ts` | Add `"re_engagement_intro"` to `AITaskType` union |
| `src/lib/playbookResolver.ts` | Change fallback intent from `pre_email_1_intro` to `re_engagement_intro` |
| `src/lib/generateDraft.ts` | Extend the rich-context payload condition to include `re_engagement_intro`; add `recommendations_json` from lead data |
| `supabase/functions/ai_task/index.ts` | Add `re_engagement_intro` prompt template and register in `KNOWLEDGE_SEARCH_TASKS` |
