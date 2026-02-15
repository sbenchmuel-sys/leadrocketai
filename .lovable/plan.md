

# Fix CSV/Excel Import Issues

## Changes

### 1. File picker visibility (`LeadImportDialog.tsx` + `CreateLeadStep.tsx`)
Update `accept` attributes to include Excel MIME types alongside extensions:
```
.csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel
```

### 2. Case-insensitive header matching (`parseLeadFile.ts`)
Normalize ALL row keys before lookup in `mapRowToLead`:
- Add a `normalizeRow()` helper that lowercases and trims all keys, storing values under canonical keys
- Map common variations to canonical names (e.g. "first name", "firstname", "first_name" all become the same lookup)
- This fixes Email, Company, Name, and every other column in one pass -- no more exact-case matching anywhere

### Files to modify
- `src/lib/parseLeadFile.ts` -- normalize row keys before mapping
- `src/components/leads/LeadImportDialog.tsx` -- update `accept` attribute
- `src/components/onboarding/CreateLeadStep.tsx` -- update `accept` attribute

