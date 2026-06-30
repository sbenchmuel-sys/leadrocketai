## Two small fixes

### 1. Rename the "In automation" chip → "In outreach"

The chip on `/app/leads` currently reads `In automation · N`, but it counts everything enrolled in a campaign OR a legacy automation_mode (`isInAutomation` in `src/lib/leadStatus.ts`). With the new outreach campaigns, a lead can be enrolled in **manual-send** mode and still be counted — which is what's confusing the user (1 auto + 1 manual = 2, but the label says both are "in automation").

**Change:**
- `src/pages/Leads.tsx` line 566: label becomes `In outreach · {chipCounts.automation}`.
- Update the surrounding comments in `src/lib/leadStatus.ts` and `src/lib/dashboardUtils.ts` so future readers know the chip means "enrolled in an outreach campaign (auto or manual) or a legacy sequence/nurture", not specifically auto-send.
- Keep the underlying predicate (`isInAutomation`) and chip key (`"automation"`) unchanged — purely a wording fix, no behavior or filtering change.

The "Auto" column on the same table is unaffected — it correctly shows On/Off based on auto-send vs manual.

### 2. LinkedIn URLs from the uploaded XLSX weren't imported

The file's header is **`LinkedIn Profile URL`**. After normalization (`src/lib/parseLeadFile.ts` → `normalizeRow`) this becomes `linkedin profile url`, which is **not** in `KEY_ALIASES`. The map only knows `linkedin url`, `linkedin`, `person linkedin url`, `person linkedin`, `linkedin_url` — so the column was silently dropped to `raw_import_json` and `lead.linkedin_url` stayed empty.

**Change in `src/lib/parseLeadFile.ts` KEY_ALIASES:**
- `"linkedin profile url"` → `linkedin_url`
- `"linkedin profile"` → `linkedin_url`
- `"profile url"` → `linkedin_url` (defensive)
- `"contact linkedin"` / `"contact linkedin url"` → `linkedin_url` (defensive)
- Also add `"street address"` → `street` (same file uses it; currently only `street` / `company street` / `address` are mapped) so the address column isn't lost either.

No backfill of already-imported leads — user can re-import the file (existing leads are matched by email and updated) or we can add a one-shot backfill if they want. Will confirm after the fix lands.

### Out of scope
- No change to the auto-send / manual-send logic or the executor.
- No DB migration; the fix is parser + label only.