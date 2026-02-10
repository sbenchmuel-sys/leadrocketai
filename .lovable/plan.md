
# Auto-populate Workspace Profile & Remove Meeting Summary Sections

## What will change

### 1. Remove "Unmatched Meeting Summaries" and "Reassign Meeting Summaries" sections
Both accordion items and their component imports will be removed from the Settings page. The component files themselves will be kept (not deleted) in case they're needed later, but they won't be rendered anywhere.

### 2. Auto-populate Workspace Profile from Knowledge Base
When the Workspace Profile card loads and fields are empty, it will check the `company_kb` and `industry_pack` data already stored in `workspace_profiles` (populated during onboarding). If there's enough data to be 80%+ confident in a value, it will pre-fill the empty form fields.

**Mapping logic:**
- `company_name` -- from `company_kb` if it contains a company name reference
- `product_name` -- from `company_kb` if identifiable
- `product_description` -- synthesized from `company_kb.differentiators` + `target_customers` if both exist
- `primary_value_props` -- already populated from onboarding extraction (direct use)
- Fields that already have user-entered values will NOT be overwritten

The auto-fill will only apply to empty fields, and the user still needs to click "Save" to persist -- nothing is saved automatically.

---

## Technical Details

### Files modified:

**`src/pages/Settings.tsx`**
- Remove imports for `UnmatchedMeetingSummariesCard` and `MatchedMeetingSummariesCard`
- Remove the two `AccordionItem` blocks for "unmatched" and "reassign" (lines 116-144)
- Remove unused icon imports (`AlertCircle`, `ArrowRightLeft`)

**`src/components/settings/WorkspaceProfileCard.tsx`**
- Update `loadProfile()` to check `company_kb` and `industry_pack` from the workspace profile
- When form fields are empty and knowledge base has relevant data, pre-fill the form state
- Add a small info badge/note indicating "Auto-filled from knowledge base" when fields were populated this way, so the user knows to review before saving
