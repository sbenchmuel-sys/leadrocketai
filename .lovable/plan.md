

## Fix: Complete KB Data Isolation & Cleanup

### Current State (Already Working)
- Demo reset correctly deletes all `kb_chunks` for the user
- KB page deletion works correctly with RLS enforcement
- `ai_task` KB retrieval is now scoped by `owner_user_id` (just fixed)
- `extract-profile-from-kb` KB query is already scoped

### Remaining Fixes Needed

#### 1. Add `owner_user_id` filter to `match_knowledge_chunks` database function

The vector search function `match_knowledge_chunks` has NO user-level filtering. If any code path calls it (or future code does), it would return chunks from all users.

**Change:** Add an `owner_user_id` parameter to the function and include a `WHERE kc.owner_user_id = owner_user_id` clause.

```sql
CREATE OR REPLACE FUNCTION public.match_knowledge_chunks(
  query_embedding extensions.vector,
  match_threshold double precision DEFAULT 0.5,
  match_count integer DEFAULT 5,
  filter_customer_facing boolean DEFAULT true,
  filter_lead_id uuid DEFAULT NULL,
  p_owner_user_id uuid DEFAULT NULL   -- NEW
)
RETURNS TABLE(id uuid, content text, title text, source text, similarity double precision)
...
WHERE
  ...
  AND (p_owner_user_id IS NULL OR kc.owner_user_id = p_owner_user_id)
```

#### 2. Scope `interactions` query in `extract-profile-from-kb`

The interactions query on lines 53-59 of `extract-profile-from-kb/index.ts` uses the service-role client but does not filter by user. This means it could pull email signatures from other users' outbound emails.

**Change:** Add a lead-ownership subquery or join to scope interactions to the current user's leads only.

```typescript
// Get the user's lead IDs first
const { data: userLeads } = await supabaseAdmin
  .from("leads")
  .select("id")
  .eq("owner_user_id", user.id);

const leadIds = (userLeads ?? []).map(l => l.id);

// Then scope interactions
const { data: emailInteractions } = await supabaseAdmin
  .from("interactions")
  .select("body_text, subject, from_email, direction, source")
  .in("lead_id", leadIds)
  .eq("direction", "outbound")
  .eq("type", "email")
  .order("occurred_at", { ascending: false })
  .limit(20);
```

### Summary of Changes

| File | Change |
|------|--------|
| SQL migration | Update `match_knowledge_chunks` to accept and enforce `owner_user_id` |
| `supabase/functions/extract-profile-from-kb/index.ts` | Scope interactions query to current user's leads |

### No changes needed for:
- `reset-demo` -- already deletes all user KB chunks
- `Knowledge.tsx` deletion -- already works correctly via RLS
- `ai_task` retrieval -- already fixed in previous edit
