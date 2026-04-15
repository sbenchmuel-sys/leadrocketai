

## Issues Found in Imported Lead Context Data

### Problem 1: Timezone-polluted dates (155 rows)
All date columns (`last_contact_date`, `Next Milestone Date`) were imported with the old code that called `String()` on JS Date objects, producing strings like `"Fri Oct 31 2025 02:00:00 GMT+0200 (Israel Standard Time)"`. The code fix was applied but only affects **new** imports — existing 155 rows in `lead_context_items` still have the bad strings.

### Problem 2: "Unnamed: 0" junk column (53 rows)
The Excel file has an index column with no header (pandas-style `Unnamed: 0`). The values are `0`, which Excel serializes as epoch date `Thu Jan 01 1970 02:00:00 GMT+0200`. These are meaningless rows polluting the context and the AI analysis.

### Problem 3: Missing column aliases
Several Excel columns aren't recognized by `KEY_ALIASES` and flow through as unmapped `imported_note` items instead of being properly categorized or suppressed:
- `"Referred by"` / `"Reffered by"` (53+2 rows) → should map to `relationship_history` (high-priority for AI)
- `"Industry / Segment"` (53 rows) → should map to `industry` (core field, not context item)
- `"Current Stage"` / `"Current Stage.1"` (54 rows) → should map to `stage` (core field)
- `"Deal Value / Type"` (53 rows) → useful commercial context, should get proper category
- `"Status Summary"` (53 rows) → should map to `history_notes`
- `"Next Milestone Date"` (47 rows) → should map to a proper date field
- `"Appears_in_Both"` (55 rows) → internal flag, should be suppressed
- `"Notes (Outcome)"` (2 rows) → should map to `history_notes`

### Problem 4: Duplicate "Current Stage" columns
`Current Stage` and `Current Stage.1` both exist — the `.1` is a pandas artifact from duplicate column headers.

---

## Plan

### Step 1: Database cleanup migration
Run a SQL migration to fix the 3 categories of bad data in-place:

**A. Fix timezone dates** — Extract clean `YYYY-MM-DD` from the polluted strings:
```sql
UPDATE lead_context_items
SET content_text = regexp_replace(original_snippet, '.*(\d{4}).*', 'Last contacted: ' || ...),
    original_snippet = <extracted clean date>
WHERE source_type = 'csv_import' AND original_snippet LIKE '%GMT%';
```

**B. Delete junk rows** — Remove `Unnamed: 0` and `Appears_in_Both` items:
```sql
DELETE FROM lead_context_items
WHERE source_type = 'csv_import'
AND source_column_name IN ('Unnamed: 0', 'Appears_in_Both', 'Current Stage.1');
```

**C. Recategorize "Referred by"** — Update to `relationship_history` category:
```sql
UPDATE lead_context_items
SET category = 'relationship_history', content_type = 'prior_contact'
WHERE source_column_name IN ('Referred by', 'Reffered by');
```

**D. Recategorize other columns**:
- `Deal Value / Type` → `commercial_signal` / `deal_value`
- `Status Summary` → `imported_note` / `prior_rep_notes`
- `Next Milestone Date` → fix date format + `historical_fact` / `milestone`

**E. Invalidate stale intelligence** — Delete all `lead_intelligence` rows for affected leads so the AI re-analyzes with clean data.

### Step 2: Add new KEY_ALIASES in `parseLeadFile.ts`
Add mappings so future imports handle these columns properly:
- `"referred by"` / `"reffered by"` → new `referral_source` field
- `"industry segment"` / `"industry / segment"` → `industry`
- `"current stage"` → `stage`
- `"deal value"` / `"deal value / type"` → new `deal_value` field
- `"status summary"` → `history_notes`
- `"next milestone date"` / `"next milestone"` → new `next_milestone_date` field
- `"notes outcome"` / `"notes (outcome)"` → `history_notes`

### Step 3: Add column suppression list in `parseLeadFile.ts`
Create a blocklist of columns to skip during context extraction:
```typescript
const SUPPRESSED_COLUMNS = new Set(["unnamed: 0", "appears_in_both", "current stage.1"]);
```

### Step 4: Add `referral_source` to ParsedLead and context extraction
- Add `referral_source` field to the `ParsedLead` interface
- Map it in `mapRowToLead`
- Add to `COLUMN_CONTEXT_RULES` with `category: "relationship_history"` (high-priority for AI weighting)
- Add `next_milestone_date` and `deal_value` similarly

### Files changed
1. **Database migration** — cleanup + invalidation SQL
2. `src/lib/parseLeadFile.ts` — new aliases, suppression list, new fields

### Impact
- 53 junk `Unnamed: 0` rows deleted
- 55 `Appears_in_Both` rows deleted
- 155 date strings cleaned to `YYYY-MM-DD`
- Referrals properly categorized as high-priority relationship context
- All affected leads get fresh AI analysis
- Future imports handle all these columns correctly

