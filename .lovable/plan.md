

# Add Excel File Support Back (Securely)

## Problem
After removing the `xlsx` library (due to Prototype Pollution and ReDoS vulnerabilities), both import dialogs only accept CSV files. Users need to import from Excel spreadsheets (.xlsx) as well.

## Solution
Add the lightweight `read-excel-file` package -- a secure, actively maintained library with no known vulnerabilities -- to parse .xlsx files. CSV parsing continues to use PapaParse.

## How It Works
1. When a user selects a file, check the extension
2. If `.csv` -- parse with PapaParse (existing logic)
3. If `.xlsx` / `.xls` -- parse with `read-excel-file`, which returns rows as arrays; treat the first row as headers, then map columns using the same dynamic header-matching logic

## Changes

### New Dependency
- `read-excel-file` -- small, secure .xlsx parser (~30KB)

### Files to Modify

**`src/components/leads/LeadImportDialog.tsx`**
- Update file `accept` to `.csv,.xlsx,.xls`
- Add a `parseExcelFile()` helper using `read-excel-file`
- Route file handling based on extension: CSV goes to PapaParse, Excel goes to `read-excel-file`
- Shared `mapRowToLead()` function normalizes headers and extracts lead fields identically for both formats
- Update UI text from "CSV" to "CSV or Excel"

**`src/components/onboarding/CreateLeadStep.tsx`**
- Same changes: accept `.csv,.xlsx,.xls`, add Excel parsing path, update labels

### No database or backend changes required

