

## Fix: KB Retrieval Cross-User Data Contamination

### Problem
The `getTextBasedKnowledgeContext` function in `supabase/functions/ai_task/index.ts` queries `kb_chunks` using a service-role client but does **not** filter by `owner_user_id`. This means any user's KB documents can leak into another user's AI-generated emails.

### Fix (2 changes in one file)

**File: `supabase/functions/ai_task/index.ts`**

1. **Add `userId` parameter** to the `getTextBasedKnowledgeContext` function signature (line ~27):
   - Add `userId: string` as a required parameter

2. **Add `owner_user_id` filter** to the query (after line 52):
   - Add `.eq("owner_user_id", userId)` to the query builder chain

3. **Pass `user.id`** at the call site (line ~1401):
   - Add `user.id` as the new argument when calling `getTextBasedKnowledgeContext`

### Technical Details

Updated function signature:
```typescript
async function getTextBasedKnowledgeContext(
  queryText: string,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,        // NEW — required
  leadId?: string
): Promise<string>
```

Updated query:
```typescript
let query = supabaseAdmin
  .from("kb_chunks")
  .select("id, title, content, source")
  .eq("owner_user_id", userId)              // NEW — enforces isolation
  .eq("allowed_customer_facing", true)
  .eq("processing_status", "completed")
  .limit(5);
```

Updated call site:
```typescript
const textContext = await getTextBasedKnowledgeContext(
  searchQuery,
  supabaseUrl,
  supabaseServiceKey,
  user.id,               // NEW
  leadId
);
```

### Impact
- Prevents KB data from one user bleeding into another user's AI generations
- No schema or migration changes needed
- No frontend changes needed
- Edge function will be auto-deployed after the edit

