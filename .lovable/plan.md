
# Speeding Up Email Generation — Full Analysis & Plan

## Where Time Is Actually Being Spent

The generation pipeline has multiple sequential and parallel steps. Here is an honest breakdown of what takes time:

```text
Client opens dialog
    │
    ├─► loadData() [parallel in browser] ─────────────────── ~300-600ms
    │       getSignatures()
    │       getKnowledgeDocuments()   ← fetches up to 50 KB chunks (slow)
    │       getRepProfile()
    │       getWorkspaceProfile()
    │
    └─► generateEmail() → streamDraft() ──────────────────── starts immediately
            │
            ├─ contextResolver() [parallel in browser] ─────── ~400-900ms
            │       getLeadDetail()
            │       getLeadEmailThread()
            │       getLeadMeetingPacks()
            │       getLeadInteractions()
            │       getRepProfile()           ← DUPLICATE - already in loadData()
            │       getWorkspaceProfile()     ← DUPLICATE - already in loadData()
            │       getKnowledgeDocuments()   ← DUPLICATE - already in loadData()
            │
            ├─ playbookResolver() ──────────────────────────── <5ms (local)
            ├─ scoreAndSelectModel() ───────────────────────── <5ms (local)
            ├─ buildAIPayload() ────────────────────────────── <5ms (local)
            │
            └─ fetch → Edge Function ──────────────────────── ~200-500ms network round trip
                    │
                    ├─ JWT validation (createClient + getUser) ─── ~100-300ms
                    ├─ DB query (load cadence if lead_id) ────────── ~100-200ms
                    ├─ Text KB search (ilike on kb_chunks) ──────── ~200-500ms
                    │
                    └─ AI Gateway → Gemini Flash/Pro ────────────── ~500-3000ms
                            First token: ~400-800ms (Flash) or ~800-2000ms (Pro)
                            Full response: ~1-4s streaming
```

**Total before first token appears: ~1.5 to 3.5 seconds.** This is the main pain felt by the user.

---

## The Key Problems

### Problem 1: Triplicated Profile Fetches
`contextResolver()` fetches `getRepProfile()`, `getWorkspaceProfile()`, and `getKnowledgeDocuments()` — but `loadData()` in the dialog already fetches all three at the same time. This is **3 unnecessary database round trips** adding ~300-600ms in duplicate overhead.

### Problem 2: Heavy KB Fetch on Every Dialog Open
`getKnowledgeDocuments()` fetches up to 50 rows of full KB chunk content in `loadData()`. This data is only used for the attachments panel. That data does not need to block generation — and most of it is never needed.

### Problem 3: Cadence Settings: Sequential DB Query Inside Edge Function
When a `lead_id` is present, the edge function runs **two sequential DB queries** (one to get `owner_user_id`, then another to get cadence settings) before it can even send to the AI gateway. These are sequential, not parallel.

### Problem 4: KB Search Is a Full iLike Table Scan
The `getTextBasedKnowledgeContext()` function uses `ilike '%term%'` pattern matching on `kb_chunks.content`. This is a **sequential scan** on the table (no index on content). On larger knowledge bases it gets increasingly slow.

### Problem 5: Pro Model for Many Tasks That Don't Need It
Several tasks in `PRO_MODEL_TASKS` could be served by Flash. `reply_to_thread` and `post_meeting_followup_email` are good candidates — Flash is fast enough for typical replies and saves ~1-2s vs Pro.

### Problem 6: No Draft Caching
When a user closes and reopens the same lead's dialog, the entire pipeline runs again from scratch. There is no reuse of a recently generated draft.

---

## Can Moving to Direct Google APIs Help?

**Short answer: marginally, and it adds significant complexity.** The Lovable AI Gateway is already calling Gemini under the hood. The latency you're seeing is mostly:
- Client-side data fetching (your own DB queries)
- The AI model's actual Time-To-First-Token

Going direct to Google's API would save the ~30-80ms gateway hop but would require managing a `GOOGLE_API_KEY` secret, handling auth/refresh, and building your own retry logic for 429s. It's not worth it for the speed gain.

**The real wins are in eliminating wasted DB round trips and switching Pro → Flash for eligible tasks.**

---

## Proposed Fixes (Ordered by Impact)

### Fix 1: Eliminate Triplicated Profile Fetches (High Impact, ~300-600ms saved)

Pass `repProfile` and `workspaceProfile` from `loadData()` into `streamDraft()` directly. The `contextResolver` should accept optional pre-fetched profiles to skip re-fetching them.

In `generateDraft.ts`, add optional fields to `GenerateDraftInput`:
```
repProfile?: RepProfile | null;
workspaceProfile?: WorkspaceProfile | null;
```

In `contextResolver.ts`, accept these as optional parameters. If already provided, skip the DB fetch:
```typescript
export async function contextResolver(
  leadId: string,
  prefetched?: { repProfile?: RepProfile | null; workspaceProfile?: WorkspaceProfile | null }
)
```

In `EmailActionDialog.tsx`, pass the loaded profiles into `streamDraft()` once they're available (they load in parallel already).

### Fix 2: Don't Wait for KB Docs Before Starting Generation (Medium Impact, ~200-400ms saved)

The `getKnowledgeDocuments()` call in `loadData()` fetches full content of up to 50 KB chunks — only used for the attachments panel. Move this to a lazy load triggered when the user opens the attachments panel, not on dialog open. This unblocks `loadData()` from blocking on a 50-row content fetch.

### Fix 3: Parallelize Edge Function DB Queries (Medium Impact, ~100-200ms saved)

Inside the `ai_task` edge function, the cadence settings lookup makes 2 sequential queries:
1. Get `owner_user_id` from `leads`
2. Get `cadence_settings` from `workspace_profiles`

These can be parallelized with a single JOIN query or run concurrently with the KB search:
```typescript
// Instead of: await query1 then await query2
// Do: const [leadData, textContext] = await Promise.all([...])
```

### Fix 4: Switch `reply_to_thread` and `post_meeting_followup_email` to Flash (High Impact, ~1-2s saved for those tasks)

`reply_to_thread` is currently assigned to Pro. For typical sales replies (not complex legal/compliance scenarios), Flash is fast and high quality. The complexity scorer already handles edge cases — if a thread has objections or legal keywords, it scores high and the edge function already detects that. Move `reply_to_thread` from `PRO_MODEL_TASKS` to the default (Flash) tier, unless the complexity score is above threshold.

The **right fix** is to honor the client-side complexity scorer's model choice inside the edge function, rather than having a hardcoded task list. Pass `model_hint` from the client:
```typescript
// In generateDraft.ts, pass complexity.model_used as model_hint to the payload
payload.model_hint = complexity.model_used;

// In ai_task edge function, use model_hint if provided:
const model = payload?.model_hint || (PRO_MODEL_TASKS.includes(task) ? "google/gemini-2.5-pro" : "google/gemini-2.5-flash");
```

### Fix 5: Short-Lived Draft Cache (Medium Impact — eliminates re-generation on re-open)

Add a simple in-memory cache in `generateDraft.ts` keyed by `lead_id + intent`. Cache lasts 5 minutes. On re-open of the same lead's dialog, serve the cached draft instantly while the pipeline runs a background refresh.

```typescript
const DRAFT_CACHE = new Map<string, { result: DraftPipelineResult; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedDraft(key: string): DraftPipelineResult | null {
  const entry = DRAFT_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { DRAFT_CACHE.delete(key); return null; }
  return entry.result;
}
```

---

## Files to Modify

| File | Change | Impact |
|---|---|---|
| `src/lib/generateDraft.ts` | Accept optional pre-fetched profiles; add draft cache | ~300-600ms + repeat opens |
| `src/lib/contextResolver.ts` | Accept optional pre-fetched profiles to skip duplicate fetches | ~300-600ms |
| `src/components/dashboard/EmailActionDialog.tsx` | Pass profiles into streamDraft; lazy-load KB docs | ~200-400ms |
| `supabase/functions/ai_task/index.ts` | Parallelize cadence DB queries; honor `model_hint` from client; move `reply_to_thread` to Flash | ~100-200ms + 1-2s on reply tasks |

## What This Will NOT Do

- Eliminate the AI model's own generation time (~400-800ms TTFT for Flash is the hard floor set by Google's infrastructure)
- Solve cold-start latency on edge function first invocation after inactivity (~500ms one-time penalty)

## Expected Total Improvement

From ~1.5-3.5s before first token appears → **~0.7-1.5s before first token appears** after all fixes. Repeat opens of same lead dialog become near-instant (cached draft).
