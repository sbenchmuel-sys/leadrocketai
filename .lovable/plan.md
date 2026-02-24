

# Fix Automation Sequence Advancement + Clean Up Raw JSON in Timeline

## Problems Identified

### 1. Raw JSON gibberish in timeline
The override event logger in `sequenceUpdater.ts` (line 317-328) stores raw `JSON.stringify({...})` as `body_text` in the `interactions` table. The timeline renders this directly, showing ugly JSON like:
```
{"event":"intent_override","suggested_intent":"pre_email_1_intro","chosen_intent":"pre_email_2_followup","previo...
```

### 2. Automation sequence not advancing after manual send
When a user manually sends an email for an automated lead, the sequence should advance past the sent step. Two bugs prevent this:

**Bug A — `wasAutomationActive` check is too narrow:** The guard at line 131 requires both `eligible_at` AND `needs_action` to be true. But if the automation poller already executed the step (setting `needs_action = false`), or if there's any timing edge case, the entire re-scheduling block (Step 2b) is skipped. The sequence stays stuck.

**Bug B — Field updates always clear `next_action_key`:** `getFieldUpdatesForIntent()` returns `next_action_key: null` for every intent. This means the main update (Step 2) always clears the automation schedule. Only Step 2b re-applies it, but only if `wasAutomationActive` was true. If that condition fails, the lead loses its automation state entirely.

## Solution

### Fix 1: Human-readable override notes
Change the override interaction logger to store a human-readable string instead of raw JSON:
- Before: `JSON.stringify({event: "intent_override", ...})`
- After: `"Sequence override: AI suggested Intro Email, rep chose Follow-up 1 (step 1 of 4)"`

### Fix 2: Always advance automation if lead has active automation
Replace the fragile `wasAutomationActive` pre-check with a more robust approach:
- Check `eligible_at` OR `automation_mode` OR `next_action_key` to determine if automation is active (not just `eligible_at && needs_action`)
- When an outbound email is manually sent on an automated lead, always advance `next_action_key` to the next step and recalculate `eligible_at`
- Preserve the safety checks (pause on reply, meeting, motion change, closed)

### Fix 3: `getFieldUpdatesForIntent` should not clear automation fields
When automation is active, the function should NOT set `next_action_key: null`. Instead, Step 2b should be responsible for ALL automation field management. The default field updates should skip `next_action_key`/`next_action_label` when the lead has active automation.

## Technical Changes

### File: `src/lib/sequenceUpdater.ts`

1. **Override log format** (lines 316-328): Replace `JSON.stringify(...)` body with a human-readable message like:
   ```
   Sequence override: suggested "${recommendedIntent}" -> chose "${overrideIntent}"
   ```

2. **Broaden `wasAutomationActive` check** (line 131): Change from:
   ```typescript
   wasAutomationActive = !!(preLead?.eligible_at) && !!(preLead?.needs_action);
   ```
   To:
   ```typescript
   wasAutomationActive = !!(preLead?.eligible_at) || !!(preLead?.needs_action);
   ```
   This ensures that if either flag is set, we attempt to schedule the next step.

3. **Preserve automation fields in getFieldUpdatesForIntent** (lines 30-85): Remove `next_action_key: null` and `next_action_label: null` from outbound sequence intents. Let Step 2b handle these fields exclusively for automated leads.

4. **Add human-readable intent labels** for the override log:
   ```typescript
   const INTENT_DISPLAY_NAMES: Record<string, string> = {
     pre_email_1_intro: "Intro Email",
     pre_email_2_followup: "Follow-up 1",
     pre_email_3_followup: "Follow-up 2",
     pre_email_4_breakup: "Breakup Email",
     // ...
   };
   ```

### File: `src/components/lead/TimelineTab.tsx`

5. **Filter out system_note entries with raw JSON from the visible timeline** or render them with a friendlier format. Add a check: if `item.type === "system_note"` and `body_text` starts with `{`, parse and render it as a formatted event badge instead of raw text.

## Expected Behavior After Fix

- When a lead has automation active and the user manually sends an email (e.g., overriding intro to follow-up), the automation advances to the correct next step (e.g., from send_pre_1 to send_pre_3)
- Override events appear as clean, human-readable notes in the timeline (e.g., "Sequence override: AI suggested Intro Email, rep chose Follow-up 1")
- Automation safety checks (reply, meeting, closed) still pause the sequence as expected

