

## Problem

When importing Excel files, date columns (like "Last Contact Date") are parsed by the `read-excel-file` library as JavaScript `Date` objects. On line 397 of `parseLeadFile.ts`, `String(rows[i][idx])` is called, which invokes `.toString()` on the Date — producing output like `"Fri Aug 01 2025 03:00:00 GMT+0300 (Israel Daylight Time)"`. The Excel cell only contains `8/1/2025` (no time, no timezone), but the browser's local timezone bleeds in.

This string then flows into:
1. The context item **label** (`Last contacted: Fri Aug 01 2025 03:00:00 GMT+0300...`)
2. The context item **raw value**
3. The `tryParseDate` function (which also uses `new Date()`, doubling down on the problem)

## Plan

### Step 1: Fix Excel date serialization in `parseLeadFile.ts`

On line 397, detect when a cell value is a `Date` object and format it as a clean `YYYY-MM-DD` string instead of calling `.toString()`:

```typescript
// Before
row[h] = String(rows[i][idx] ?? "").trim();

// After — detect Date objects from Excel and format cleanly
const cellVal = rows[i][idx];
if (cellVal instanceof Date) {
  // Use UTC to avoid timezone shift (Excel dates have no timezone)
  const y = cellVal.getUTCFullYear();
  const m = String(cellVal.getUTCMonth() + 1).padStart(2, "0");
  const d = String(cellVal.getUTCDate()).padStart(2, "0");
  row[h] = `${y}-${m}-${d}`;
} else {
  row[h] = String(cellVal ?? "").trim();
}
```

### Step 2: Fix `tryParseDate` to use UTC-safe parsing

Replace the `new Date(value)` call with explicit UTC parsing to prevent timezone shifts when storing the `context_date`:

```typescript
function tryParseDate(value: string): string | null {
  if (!value) return null;
  // Match YYYY-MM-DD or MM/DD/YYYY or DD/MM/YYYY patterns
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    if (!isNaN(d.getTime())) return d.toISOString();
    return null;
  }
  // Fallback for other formats
  const d = new Date(value);
  if (!isNaN(d.getTime())) return d.toISOString();
  return null;
}
```

### Step 3: Fix label formatting

On line 288, the label already uses the raw string value. After Step 1, this will naturally show `Last contacted: 2025-08-01` instead of the full timezone string — no additional change needed.

### Impact

- **New imports** will store clean date strings (`2025-08-01`) in labels, raw values, and context dates
- **Existing imported leads** with the bad date strings will remain as-is (can be re-imported to fix)
- Two files changed: `src/lib/parseLeadFile.ts` only

