
# Plan: Remove Hardcoded "Binah" Reference

## Finding

There is only **one hardcoded "Binah" reference** in the codebase:

| File | Line | Current Text |
|------|------|--------------|
| `src/lib/supabaseQueries.ts` | 2 | `// Database query functions for Binah Deal Assistant` |

The system prompts (`src/prompts/systemPrompt.ts` and `supabase/functions/ai_task/index.ts`) do **not** contain "Binah" - they reference "regulated B2B" and healthcare industries, but per your request, I will not modify those.

---

## Change

**File: `src/lib/supabaseQueries.ts` (line 2)**

```typescript
// FROM:
// Database query functions for Binah Deal Assistant

// TO:
// Database query functions for Deal Assistant
```

---

## Important Note

The "Binah" content appearing in your AI-generated emails is coming from your **database**, not hardcoded prompts. Specifically, your `workspace_profiles` record contains:

- **company_name**: "Binah.ai"
- **product_name**: "Binah.ai' SDK"  
- **product_description**: Full Binah SDK description
- **primary_value_props**: Binah-specific value propositions

To make the platform truly generic, you need to **clear or update your Workspace Profile** in **Settings > Workspace Profile** within the app. This is stored in the database and cannot be removed via code changes.
