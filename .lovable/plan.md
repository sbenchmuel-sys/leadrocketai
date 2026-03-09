

## Column Mapping Analysis: Your ONT_Lead_Gen.xlsx

Your file has **14 columns**. Here's what happens to each:

### Currently Mapped (7 columns)
| Excel Column | Maps To | Used in Emails? |
|---|---|---|
| First Name | `name` (combined with Last Name) | Yes — greeting, personalization |
| Last Name | `name` (combined with First Name) | Yes — greeting, personalization |
| Company Name | `company` | Yes — company references |
| Email | `email` | Yes — delivery address |
| Title | `job_title` | Yes — context for AI drafts |
| Phone | `phone` | Stored but not used in email campaigns |
| Industry | `industry` | Yes — AI uses for industry-relevant messaging |

### Currently Dropped (7 columns)
| Excel Column | What Happens |
|---|---|
| **Website** | Completely ignored during import |
| **Person Linkedin Url** | Completely ignored |
| **Company Linkedin Url** | Completely ignored |
| **Company Street** | Completely ignored |
| **Company City** | Completely ignored |
| **Company State** | Completely ignored |
| **Company Country** | Maps to `country` column — this IS captured |

So actually **Company Country** is mapped. That leaves **6 columns dropped**: Website, Person LinkedIn, Company LinkedIn, Street, City, State.

### What's Missing from AI Context

The `contextResolver.ts` feeds the AI all lead fields when generating drafts. The `leads` table already has a `country` field, but there's no place for website, LinkedIn URLs, city, or state. These could significantly improve personalization:

- **Website** — AI can reference the prospect's actual business, products, services
- **Person LinkedIn URL** — AI can mention shared connections or recent posts (with enrichment)
- **City/State** — AI can use geographic proximity, local references, regional relevance ("fellow Ontario business")

---

## Recommended Plan

### Option A: Store extra fields in `initial_message` as structured context (Quick, no DB change)

During import, concatenate the unmapped columns into the `initial_message` field as structured context the AI already reads:

```
LEAD CONTEXT:
- Website: www.edgeimaging.ca
- LinkedIn: linkedin.com/in/jim-agnew
- Location: Burlington, Ontario, Canada
```

**Pros**: No database migration, AI already reads `initial_message` in prompts.
**Cons**: Mixes data with any actual message; not queryable.

### Option B: Add columns to the leads table (Recommended)

Add `website`, `linkedin_url`, `city`, `state` columns to the `leads` table. Update the parser to map them. Update `contextResolver.ts` to include them in AI context.

**Implementation**:
1. **DB migration** — Add 4 nullable text columns: `website`, `linkedin_url`, `city`, `state`
2. **parseLeadFile.ts** — Add aliases for new columns (`website`, `person linkedin url`, `company street` → `street`, `company city` → `city`, `company state` → `state`); expand `ParsedLead` interface
3. **LeadImportDialog.tsx** — Pass new fields in insert payload
4. **contextResolver.ts** — Include new fields in the resolved context passed to AI
5. **automation-executor** — Already reads all lead fields from the SELECT query; just needs the new columns added to the select

**Pros**: Clean, queryable, available to all AI prompts automatically.
**Cons**: Requires a small migration.

### Option C: Flexible `custom_fields` JSON column (Future-proof)

Add a single `custom_fields jsonb` column to `leads`. Any unmapped columns from the spreadsheet get stored there. The AI prompt includes them as additional context.

**Pros**: Handles any spreadsheet format without new migrations.
**Cons**: Not queryable without JSON operators; slightly more complex prompt injection.

### My Recommendation

**Option B** for the known high-value fields (website, linkedin_url, city, state), with the parser also capturing Company LinkedIn URL since your file includes it. This gives the AI rich context for personalization — mentioning the prospect's website, their local area, and their LinkedIn presence makes outbound emails significantly more relevant.

The 5 new fields to add:
- `website` — prospect's company website
- `linkedin_url` — person's LinkedIn profile
- `company_linkedin_url` — company's LinkedIn page
- `city` — company city
- `state` — company state/province

