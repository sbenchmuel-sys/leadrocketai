
# Fix: Route DraftsTab Through Full Composer + Resolve Rep Name Placeholders

## Problem
1. The "Generate Draft" button in DraftsTab runs AI inline and shows results in a basic textarea, bypassing the full EmailActionDialog composer which provides signatures, KB attachments, shorten/rewrite tools, thread context, and motion controls.
2. Generated emails sometimes contain `{Rep's first name}` or similar placeholders instead of the actual rep name.

## Solution

### 1. DraftsTab: Open EmailActionDialog Instead of Inline Generation

**File: `src/components/lead/DraftsTab.tsx`**

- Remove the inline `handleGenerate()` function that calls `generateDraft()` + `runTask()` directly
- Remove the inline generated content card (the textarea showing generated email)
- When user clicks "Generate Draft", open the `EmailActionDialog` with the selected intent and composer note as initial instructions
- The EmailActionDialog already has all the features: signatures, KB, shorten, rewrite, thread display, motion override, send/Gmail buttons
- Pass the selected channel intent as the `actionKey` so the dialog generates the right type of email
- Pass `composerNote` as `initialInstructions`

**Changes:**
- The "Generate Draft" button sets `showEmailDialog = true` with the appropriate action key mapped from the selected intent
- Remove `generatedContent`, `generatedSubject`, `knowledgeUsed` state variables and the generated content card UI
- Keep the channel toggle and intent selector as they feed into the dialog
- Map `ComposerIntent` to an `actionKey` string that EmailActionDialog understands (e.g., `follow_up` maps to `send_pre_2_followup`, `post_meeting_recap` maps to `generate_post_meeting_recap`)

### 2. Post-Process AI Output to Replace Placeholders

**File: `src/components/dashboard/EmailActionDialog.tsx`**

After the AI returns `result.content`, run a placeholder replacement pass:
- Replace `{Rep's first name}`, `[Rep's first name]`, `{Your Name}`, `[Your Name]`, `{Sender Name}`, `[Sender Name]` with the actual rep first name from `repProfile.full_name`
- Replace `{Rep's First Name}` (case variants) similarly
- If no rep profile exists, fall back to an empty string (remove the placeholder entirely)

This ensures every email is ready to send with the actual name signed.

**File: `src/lib/generateDraft.ts`** (or a new utility)

Add a `resolveEmailPlaceholders(text, repProfile)` function:
```
function resolveEmailPlaceholders(text: string, repName: string | null): string {
  const firstName = repName?.split(' ')[0] || '';
  return text
    .replace(/\{Rep's\s*first\s*name\}/gi, firstName)
    .replace(/\[Rep's\s*first\s*name\]/gi, firstName)
    .replace(/\{Your\s*Name\}/gi, firstName)
    .replace(/\[Your\s*Name\]/gi, firstName)
    .replace(/\{Sender\s*Name\}/gi, firstName)
    .replace(/\[Sender\s*Name\]/gi, firstName);
}
```

Apply this in `EmailActionDialog.generateEmail()` right after `result.content` is received, before setting it into the body state.

## Technical Details

### DraftsTab changes
- Remove: `generatedContent`, `generatedSubject`, `knowledgeUsed` state
- Remove: `handleGenerate()` function (lines 275-377)
- Remove: generated content Card (lines 507-588)
- Keep: channel toggle, intent selector, composer note input, saved drafts list
- Modify: "Generate Draft" button now opens EmailActionDialog with mapped action key
- Add intent-to-actionKey mapping:
  - `follow_up` -> `send_pre_2_followup`
  - `inbound_response` -> `reply_now`
  - `reply_to_thread` -> `reply_now`
  - `post_meeting_recap` -> `generate_post_meeting_recap`
  - `closing_nudge` -> `send_pre_3_followup`
  - `nurture_email` -> `send_nurture_1`
- For LinkedIn/WhatsApp: keep inline generation since EmailActionDialog is email-only

### EmailActionDialog changes
- Add `resolveEmailPlaceholders()` utility function
- Apply it after AI content is set (in `generateEmail()` and `runOneClickAction()`)
- The rep profile is already loaded in `loadData()` so the name is available

### Files modified
1. `src/components/lead/DraftsTab.tsx` -- route email generation to EmailActionDialog
2. `src/components/dashboard/EmailActionDialog.tsx` -- add placeholder resolution post-processing
