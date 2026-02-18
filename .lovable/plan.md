
# Fix: Robust Intent JSON Parsing in WhatsApp Webhook

## Root Cause

In `supabase/functions/whatsapp-webhook/index.ts`, lines 470–477, the intent classification response from `ai_task` is parsed with a bare `JSON.parse(intentData.content)`. The LLM (Gemini Flash) occasionally wraps its JSON output in markdown code fences (` ```json ... ``` `) or adds a trailing comma/explanation sentence — both of which cause `JSON.parse` to throw, the `catch` block silently sets `intent = "unknown"` and `aiConfidence = 0`, and the decision engine then correctly blocks automation due to `low_confidence`.

## What the Fix Does

A `extractJsonFromResponse` helper function is added directly inside `whatsapp-webhook/index.ts`. This function is called in place of the bare `JSON.parse`. No changes to `ai_task`, email logic, or any other file.

The helper follows this cascade:

1. **Direct parse** — try `JSON.parse(content)` first (fastest path, works when LLM is well-behaved)
2. **Strip markdown code fences** — remove ` ```json ... ``` ` wrappers and retry parse
3. **Find JSON object boundaries** — use a regex to locate the first `{` and last `}` in the string and retry parse on that substring
4. **Repair common issues** — remove control characters (`\x00–\x1F`), fix trailing commas before `}` or `]`, then retry parse
5. **Throw if all fail** — so the existing `catch` block logs the warning and continues

Additionally, two small defensive improvements are added to the same block:
- Log the raw `intentData.content` (first 200 chars) when parse fails, so the actual LLM output is visible in edge function logs for debugging.
- Validate that the extracted `intent` value is one of the known intent strings before trusting it.

## Technical Changes

**File: `supabase/functions/whatsapp-webhook/index.ts`**

1. Add `extractJsonFromResponse(content: string): unknown` utility function near the top of the file (after the existing utility functions, around line 115).

2. Replace the parse block at lines 470–477:

```
// BEFORE (fragile):
const parsed = JSON.parse(intentData.content);
intent = parsed.intent ?? intent;
aiConfidence = typeof parsed.confidence === "number" ? parsed.confidence : aiConfidence;
riskFlags = Array.isArray(parsed.risk_flags) ? parsed.risk_flags : [];
```

```
// AFTER (robust):
const parsed = extractJsonFromResponse(intentData.content) as any;
const KNOWN_INTENTS = ["acknowledgment","scheduling","clarification","objection","complaint","unsubscribe","negotiation","legal","positive_interest","unknown"];
intent = KNOWN_INTENTS.includes(parsed.intent) ? parsed.intent : (intent);
aiConfidence = typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : aiConfidence;
riskFlags = Array.isArray(parsed.risk_flags) ? parsed.risk_flags : [];
console.log(`[whatsapp-webhook] Intent classified: ${intent} (confidence: ${aiConfidence})`);
```

3. Update the `catch` block to log the raw content for debugging:

```
} catch (parseErr) {
  console.warn("[whatsapp-webhook] Failed to parse intent JSON. Raw content:", intentData.content?.slice(0, 200));
}
```

## Scope

- Only `supabase/functions/whatsapp-webhook/index.ts` is modified
- No changes to `ai_task`, email automation, database schema, or any other file
- Fully additive and backwards-compatible
- The function will be redeployed automatically
