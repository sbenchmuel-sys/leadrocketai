

## Speed Up Draft Generation

### Problem
Draft generation takes too long (8-15+ seconds) even for simple follow-up emails using Flash. The slowness comes from redundant data fetching, no streaming, and over-use of the Pro model.

### Root Causes (in order of impact)

| Bottleneck | Time Cost | Fix |
|---|---|---|
| No streaming -- full response buffered before display | +3-8s | Stream tokens to UI |
| Double `contextResolver` call (logging + generateDraft) | +1-3s | Call once, pass result |
| Sequential loadData then generateEmail | +1-2s | Parallelize |
| Too many tasks on Gemini Pro (2-3x slower than Flash) | +2-5s | Move simple tasks to Flash |
| KB search on simple follow-ups (unnecessary) | +0.5-1s | Skip KB for follow-ups |

### Fix 1: Stream AI Response (biggest impact)

Currently the edge function does `await response.json()` which waits for the entire LLM response. Instead, stream SSE tokens back to the client so the user sees text appearing in real-time.

**Edge function change**: Instead of buffering the full response, pipe the gateway's SSE stream directly back to the client when a `stream: true` flag is passed.

**Client change**: In `EmailActionDialog`, use `fetch()` with SSE parsing to render tokens as they arrive into the body textarea. The user sees the email being "typed out" -- perceived latency drops from 8s to under 1s for first token.

For non-streaming callers (automation-executor, nurture-pre-generate), the existing buffered path remains unchanged.

### Fix 2: Eliminate Redundant Data Fetching

**Remove the duplicate `contextResolver` call in EmailActionDialog.tsx**:
- Currently lines 277-306 call `contextResolver()` purely for console logging
- Then `generateDraft()` calls it again internally
- Fix: Remove the standalone call; the pipeline result already contains all the logged data

**Parallelize `loadData` with draft generation**:
- Currently `profilesLoaded` gates `generateEmail()`
- Fix: Start both in parallel. The edge function already fetches its own context server-side, so the client-side profile fetch is only needed for signature selection (not for AI generation)

### Fix 3: Reduce Pro Model Usage

Move these tasks from Pro to Flash -- they're short-form emails (70-140 words) that don't require deep reasoning:

| Task | Current Model | Proposed | Reason |
|---|---|---|---|
| `pre_email_3_followup` | Pro | Flash | 70-120 word check-in email |
| `pre_email_4_breakup` | Pro | Flash | Short breakup, template-driven |
| `analyze_outgoing_email` | Pro | Flash | Simple JSON classification |
| `reply_to_thread` | Keep Pro | Pro | Needs deep context understanding |

### Fix 4: Skip KB Search for Simple Follow-ups

Remove `pre_email_2_followup`, `pre_email_3_followup`, `pre_email_4_breakup` from `KNOWLEDGE_SEARCH_TASKS`. These emails reference previous outreach, not product knowledge. This saves a DB query + processing time per generation.

---

### Technical Details

**Files to change:**

| File | Change |
|---|---|
| `supabase/functions/ai_task/index.ts` | Add streaming path (when `stream: true` in body); remove 3 tasks from `PRO_MODEL_TASKS`; remove 3 tasks from `KNOWLEDGE_SEARCH_TASKS` |
| `src/components/dashboard/EmailActionDialog.tsx` | Remove duplicate `contextResolver` call; implement SSE streaming for body textarea; parallelize loadData with generation |
| `src/lib/generateDraft.ts` | Add a `streamDraft()` export that returns a ReadableStream instead of buffered text |
| `src/hooks/useAITask.ts` | No changes needed (streaming bypasses this hook) |

**Streaming flow:**

```text
User clicks Generate
        |
        v
Client sends POST to ai_task with stream: true
        |
        v
Edge function pipes gateway SSE -> client
        |
        v
Client parses SSE line-by-line, updates body state per token
        |
        v
User sees email appearing in ~0.5-1s (first token)
```

**Backward compatibility**: The existing non-streaming path (`stream: false` or omitted) remains unchanged for automation-executor, nurture-pre-generate, and other server-to-server callers.

**Expected improvement**: Generation perceived time drops from 8-15s to under 1s for first visible token. Total generation time also drops ~3-5s from model/KB optimizations.

