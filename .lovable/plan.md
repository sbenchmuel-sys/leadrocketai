
# Phase 1: Unified Draft Pipeline (Foundation)

## Overview
Create a centralized draft generation service layer that resolves context, determines the right playbook/intent, and feeds the EmailActionDialog composer. No UI changes -- this is pure infrastructure with console logging for verification.

## New Files

### 1. `src/lib/contextResolver.ts` -- Context Resolver
Fetches and assembles all lead context needed for draft generation in a single call.

**Input:** `lead_id: string`

**Output:** `ResolvedContext` object containing:
- Lead data: `source_type`, `motion`, `strategy`, `stage`, `status`
- Sequence state: derived `sequence_type`, `sequence_step`, `sequence_status` (computed from `next_action_key`, `motion`, interactions)
- Email history: `last_outbound_email`, `last_inbound_email` (from `getLeadEmailThread`)
- Meeting data: `last_meeting_summary` (from `getLeadMeetingPacks`)
- Intelligence: `buying_signals`, `risk_signals` (parsed from `milestones_json`, `risks_json`)
- Engagement: `engagement_level`, `closing_power` (from `calculateClosingPower` in `closingPowerUtils.ts`)
- Knowledge: `company_kb`, `industry_kb`, `persona_kb` (from workspace profile's `company_kb`, `industry_pack`, and KB chunks)

**Implementation approach:**
- Parallel-fetch lead detail, email thread, meeting packs, workspace profile, rep profile, and knowledge docs using `Promise.all`
- Parse `milestones_json` for buying signals (pricing, decision-maker, docs-requested patterns -- reuse patterns from `closingPowerUtils.ts`)
- Parse `risks_json` for risk signals
- Derive `sequence_type` from motion + action key (e.g., `outbound_prospecting` motion with `send_pre_2` action = outbound sequence step 2)
- Derive `sequence_step` number from `next_action_key` pattern matching

### 2. `src/lib/playbookResolver.ts` -- Playbook Resolver
Takes resolved context and determines the recommended intent, playbook name, and next sequence step.

**Input:** `context: ResolvedContext`

**Output:** `PlaybookRecommendation` object:
- `recommended_intent`: the AI task type to use (e.g., `pre_email_2_followup`, `reply_to_thread`, `nurture_email_single`)
- `recommended_playbook`: human-readable label (e.g., "Outbound Prospecting", "Post-Meeting Follow-up")
- `next_sequence_step`: step number or label (e.g., "Step 2 of 4", "Nurture Email 1")

**Rules (priority order):**
1. If meeting exists and no recap sent --> `post_meeting_followup_email`
2. If inbound reply exists and no outbound after it --> `reply_to_thread`
3. If motion = `nurture` --> `nurture_email_single`
4. If motion = `closing` --> `pre_email_3_followup` (closing nudge)
5. If `next_action_key` exists --> map directly (reuse existing `getAITaskForAction` logic)
6. Default: derive from motion + source_type (outbound = intro/followup sequence, inbound = response)

### 3. `src/lib/generateDraft.ts` -- Unified Draft Generator
The single entry point that orchestrates context resolution, playbook selection, and returns everything the composer needs.

**Input:**
```
{
  lead_id: string,
  channel?: "email" | "linkedin" | "whatsapp",  // default "email"
  override_intent?: AITaskType | null,           // user manually selected intent
  instructions?: string | null,                  // custom user notes
  motion_override?: Motion | null                // user changed motion in composer
}
```

**Output:** `DraftPipelineResult`
```
{
  resolved_context: ResolvedContext,
  playbook: PlaybookRecommendation,
  recommended_intent: AITaskType,
  recommended_playbook: string,
  sequence_step: string,
  draft_text: string | null  // null until AI generates it
}
```

**Behavior:**
- Calls `contextResolver(lead_id)`
- Calls `playbookResolver(context)` 
- If `override_intent` is provided, uses that instead of recommended intent
- Logs all resolved data to console for verification
- Does NOT call the AI task yet (that stays in `EmailActionDialog.generateEmail()` for now)
- Returns the recommendation so the composer can use it

### 4. Wire into `EmailActionDialog.tsx`

**Changes (minimal, additive):**
- Import `generateDraft` from the new service
- In the existing `generateEmail()` function, call `generateDraft()` BEFORE the existing logic
- Log the returned `resolved_context`, `recommended_intent`, and `playbook` to console
- Do NOT replace existing generation logic yet -- the new pipeline runs alongside it
- The existing `getAITaskForAction`, `buildLeadContext`, `getPlaybookLabel` functions remain untouched

**Console output pattern:**
```
[generateDraft] Context resolved for lead xyz
[generateDraft] Recommended: { intent: "pre_email_2_followup", playbook: "Outbound Prospecting", step: "Step 2 of 4" }
[generateDraft] Actual (legacy): { actionKey: "send_pre_2_followup", taskType: "pre_email_2_followup" }
```

This lets us verify the new pipeline recommends correctly without breaking anything.

## Technical Details

### File structure
```
src/lib/contextResolver.ts    -- ResolvedContext type + contextResolver()
src/lib/playbookResolver.ts   -- PlaybookRecommendation type + playbookResolver()  
src/lib/generateDraft.ts      -- generateDraft() orchestrator
```

### Dependencies used (all existing)
- `getLeadDetail`, `getLeadEmailThread`, `getLeadMeetingPacks`, `getLeadInteractions` from `supabaseQueries`
- `getRepProfile`, `getKnowledgeDocuments` from `repProfileQueries`
- `getWorkspaceProfile`, `formatWorkspaceContext` from `workspaceProfileQueries`
- `calculateClosingPower` from `closingPowerUtils`
- `getActionType`, `Motion`, `SourceType` from `dashboardUtils`
- `AITaskType` from `useAITask`

### What stays the same
- All existing composer UI and behavior
- All existing AI task calls
- EmailActionDialog's `generateEmail()` still does the actual generation
- DraftsTab's intent selection still works as before
- No database changes needed

### Verification checklist
- Composer still generates emails as before
- Console shows correct recommended intent matching what legacy logic produces
- No UI breakage
- No automation changes
