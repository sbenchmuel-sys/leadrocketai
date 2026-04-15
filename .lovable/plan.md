## ✅ Completed: Include Lead Context in AI Intelligence with Freshness & Weighting

### What was done

**1. Database migration — Auto-invalidation trigger**
- Created `invalidate_lead_intelligence_on_context()` trigger function
- Trigger fires on INSERT/UPDATE/DELETE of `lead_context_items`
- Deletes stale `lead_intelligence` and `lead_context_cache` rows, forcing fresh recomputation

**2. Edge function — `recompute-lead-intelligence/index.ts`**
- Added parallel fetch for `lead_context_items` (active, up to 30 items)
- Registered context items as evidence with `source_type: "lead_context"`
- High-priority categories (`caution`, `relationship_history`) get `⚠️ HIGH PRIORITY` prefix
- Caution items automatically added as high-level risks
- Context items injected into LLM prompt with explicit weighting instruction
- Updated `source_counts_json` to include `lead_context_items` count
- LLM trigger condition expanded to include context items

### Priority weighting

| Category | Weight | Effect |
|----------|--------|--------|
| `caution` | ⚠️ HIGH | Auto-added as risk + flagged in prompt |
| `relationship_history` | ⚠️ HIGH | Flagged in prompt (referrals, warm intros) |
| All others | Normal | Included in prompt without flag |
