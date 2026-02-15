

# Fix Inbound Lead Email Draft — Align Playbook with Inbound Context

## Problem
When composing an email for an inbound lead (e.g., someone who submitted "I am interested in your product for remote monitoring of my patients"), the system generates a cold outreach email instead of acknowledging the lead's interest. The email reads like the rep is reaching out for the first time, ignoring the lead's initial message entirely.

## Root Cause
The `inbound_response` composer intent maps to the `pre_email_1_intro` AI task, which is a cold outreach prompt ("Cold Intro in an outbound prospecting cadence — Trigger a reply"). Inbound leads should instead use a prompt that acknowledges their message and converts interest into a conversation.

## Changes

### 1. Add a dedicated `inbound_intro` task prompt (edge function)
**File**: `supabase/functions/ai_task/index.ts`

Add a new prompt `inbound_intro` to the PROMPTS dictionary specifically for inbound first-touch emails:
- Objective: Acknowledge the lead's message, provide one helpful detail, offer a clear next step
- References `{{LEAD_CARD_MESSAGE}}` (their initial message) and `{{KNOWLEDGE_CONTEXT}}`
- Tone: Warm, responsive, not salesy -- convert interest into a conversation
- Length: 100-150 words
- Structure: Acknowledge their interest, provide one relevant value point, propose a next step (meeting or reply)

Also add `"inbound_intro"` to the `KNOWLEDGE_SEARCH_TASKS` array so knowledge context is injected.

### 2. Map `inbound_response` intent to the new task
**File**: `src/components/lead/DraftsTab.tsx`

Change the mapping:
```
inbound_response: "inbound_intro"  // was: "pre_email_1_intro"
```

### 3. Add `inbound_intro` to the AITaskType union
**File**: `src/hooks/useAITask.ts`

Add `"inbound_intro"` to the type union so TypeScript accepts it.

### 4. Ensure the lead's initial message is passed to the new prompt
**File**: `src/lib/generateDraft.ts`

The `lead_card_message` is already set when `thread_emails.length === 0 && lead.initial_message` exists (line 142). The new prompt template will reference `{{LEAD_CARD_MESSAGE}}` to include this context.

### 5. Wire up inbound motion block in the edge function
**File**: `supabase/functions/ai_task/index.ts`

The existing `buildMotionBlock` already has an `inbound_response` block (lines 293-305). Ensure the new `inbound_intro` task uses the `inbound_response` motion so this block gets injected correctly.

### 6. Update the playbook resolver for inbound intro
**File**: `src/lib/playbookResolver.ts`

In `deriveDefault`, when source is inbound and there's no thread, change the recommended intent from `pre_email_1_intro` to `inbound_intro` so the playbook header correctly shows "Inbound Intro" with the right task.

## Technical Details

New prompt structure for `inbound_intro`:
- Acknowledges the lead's initial message directly
- Uses knowledge context to provide one relevant value point
- Proposes a clear next step (meeting or reply)
- Warm, responsive tone -- not a cold pitch
- 100-150 words max
- References: `LEAD_CONTEXT`, `REP_CONTEXT`, `LEAD_CARD_MESSAGE`, `KNOWLEDGE_CONTEXT`, `MEETING_LINK`, `CUSTOM_INSTRUCTIONS`

