

## Problem Statement

Two bugs need fixing:

1. **`action_instructions` not wired anywhere** — The `leads.action_instructions` column exists but is never read by:
   - The **automation-executor** (hardcodes `custom_instructions: null` at line 614)
   - The **client-side generateDraft** pipeline (never reads `action_instructions` from the lead; only uses the `instructions` param passed from the UI composer)

2. **No bulk campaign instructions UI** — When enabling automation on multiple leads via `BulkAutomationDialog`, there is no way to set shared instructions (meeting CTA, promotional content for specific steps). This applies to all motions (outbound, inbound, nurture).

---

## Plan

### 1. Wire `action_instructions` into automation-executor

**File:** `supabase/functions/automation-executor/index.ts`

- Add `action_instructions` to the SELECT query on line 147
- Replace `custom_instructions: null` on line 614 with `custom_instructions: lead.action_instructions || null`
- Ensure the post-send state update does NOT clear `action_instructions` (verify lines ~815-858)

### 2. Wire `action_instructions` into client-side draft generation

**File:** `src/lib/generateDraft.ts`

- In the main `generateDraft` / `streamDraft` functions, after resolving context, read `action_instructions` from the lead record
- Merge it with any user-provided `instructions` param (user instructions take priority, lead instructions are appended)
- This ensures single-email previews and manual draft generation also respect saved instructions

### 3. Add Campaign Settings UI to BulkAutomationDialog

**File:** `src/components/dashboard/BulkAutomationDialog.tsx`

Add a collapsible "Campaign Settings" section before the lead list with:

- **Meeting CTA toggle** (checkbox) — "Include meeting booking link in all emails"
- **Campaign instructions** (textarea) — Global instructions for all steps (e.g., "Focus on healthcare compliance")
- **Step-specific instructions** — Accordion with textareas for each step:
  - Step 1 (Intro Email)
  - Step 2 (Follow-up 1) 
  - Step 3 (Follow-up 2)
  - Step 4 (Breakup / final)

On confirm, compose a single `action_instructions` string from these fields and save it to each lead's `action_instructions` column. Format:

```
CAMPAIGN RULES:
- Always include a meeting booking CTA with calendar link
STEP 2 INSTRUCTIONS:
- Include promotional starter kit offer
STEP 3 INSTRUCTIONS:
- Remind about starter kit promotion expiry
```

### 4. Ensure instructions persist across sequence steps

**Files:** 
- `supabase/functions/automation-executor/index.ts` — Verify post-send update does not null out `action_instructions`
- `supabase/functions/gmail-send/index.ts` and `outlook-send/index.ts` — Check if they clear `action_instructions` after send; if so, skip clearing when the send originates from the automation executor (add an `automated: true` flag in the send payload)

### 5. Support step-specific instruction extraction in executor

**File:** `supabase/functions/automation-executor/index.ts`

When building the AI payload, parse `action_instructions` for step-specific blocks. If the current `next_action_key` matches a step number, extract and prioritize that step's instructions alongside the global campaign rules.

---

## Technical Notes

- No database migrations needed — `action_instructions` column already exists on `leads`
- The `ai_task` edge function already supports `{{CUSTOM_INSTRUCTIONS}}` in prompt templates — once the executor passes the value, it flows through automatically
- The `BulkAutomationDialog` already handles per-lead updates in `handleConfirm` — we add `action_instructions` to the update payload
- Nurture leads use the same `action_instructions` column, so this works for all motions

