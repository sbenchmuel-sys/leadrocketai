

## Problem

The onboarding import in `CreateLeadStep.tsx` spreads the entire `ParsedLead` object (including fields like `priority_label`, `owner_name`, `previous_owner`, `caution`, `competitor`, `objection`, `pain_point`, etc.) directly into the Supabase `leads.insert()` call. These fields don't exist as columns on the `leads` table, so the insert fails.

The existing `LeadImportDialog.tsx` (used on the Leads page) already handles this correctly by stripping those extended fields and routing them to `personal_notes` and `lead_context_items`. The onboarding flow was never updated with this logic.

## Plan

### Step 1: Fix the onboarding import to match LeadImportDialog logic

Update `src/components/onboarding/CreateLeadStep.tsx` `handleFileImport`:

- **Strip extended fields** before spreading into the insert payload (same destructuring pattern as `LeadImportDialog` lines 108-113)
- **Build `personal_notes`** from supplementary fields (history, owner, priority, source, product, last contact date)
- **Generate client-side UUIDs** for each lead so context items can reference them
- **Map `next_step_text` → `next_step`** and validate `stage` against known values
- **Preserve `raw_import_json`** for full data retention

### Step 2: Extract and insert lead context items

After the leads insert succeeds, call `extractLeadContextItems()` (already implemented in `parseLeadFile.ts`) for each lead and batch-insert into `lead_context_items`. This ensures caution flags, competitor intel, pain points, objections, and other extended data are stored for AI personalization.

### Data Maximization

Every column from the Excel file will be utilized:
- **Core fields** (name, company, email, phone, job title, industry, country, city, state, website, LinkedIn URLs) → direct `leads` table columns
- **Stage, next step** → mapped to `leads.stage` and `leads.next_step`
- **History, owner, priority, source, product, last contact** → combined into `leads.personal_notes`
- **Caution, competitor, objection, pain point** → extracted into `lead_context_items` for AI retrieval
- **All unmapped columns** → captured in `raw_import_json` and also extracted as general context items
- **No data is discarded** — everything is preserved either structurally or verbatim

### Technical Details

The fix mirrors the proven pattern from `LeadImportDialog.tsx` (lines 89-160), applying the same field stripping, personal notes aggregation, UUID generation, and context item extraction to the onboarding flow.

