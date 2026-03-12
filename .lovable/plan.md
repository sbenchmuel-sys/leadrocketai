

## Problem

The Excel import correctly parses `website`, `linkedin_url`, `company_linkedin_url`, `city`, and `state` and writes them to the database. However, the **Edit Lead dialog** (`EditLeadDialog.tsx`) does not include form fields for these columns, so:
1. They appear missing when viewing/editing the lead
2. Editing a lead would silently null out these fields (since they aren't in the update payload)

## Plan

### 1. Update `EditLeadDialog.tsx`

**Add to Zod schema** (5 new optional string fields):
- `website`, `linkedin_url`, `company_linkedin_url`, `city`, `state`

**Add default values** from `lead.*` for each new field.

**Add to `onSubmit` update payload** so these fields are persisted on save.

**Add form fields** in the UI, organized as:
- Row: Website + LinkedIn URL
- Row: Company LinkedIn URL (full width or paired with City)
- Row: City + State

These go between the Country/Meeting Link row and the Deal Stage row.

### 2. Verify `LeadDetail` type

Confirm that `LeadDetail` (from `supabaseQueries.ts`) includes these columns in its select query. If not, add them to the query so the form can populate.

