

# Cost-Saving Strategies for Lead Rocket AI

## Current Cost Drivers

Every AI call currently goes fresh to the Lovable AI Gateway with no reuse. The biggest savings come from **avoiding duplicate calls** and **downgrading models** where quality impact is minimal.

---

## Strategy 1: Draft Caching (Highest Impact)

**Problem**: If a user previews a draft, edits nothing, and clicks "Regenerate," the full AI call repeats. Automated sequences also regenerate from scratch on retry.

**Solution**: Cache generated drafts in the `drafts` table keyed by `(lead_id, step_key, status='pending')`. Before calling AI, check if an unexpired pending draft already exists.

- Already partially done in `nurture-pre-generate` (it checks for existing drafts)
- Apply the same pattern to `automation-executor` before calling `ai_task`
- On the frontend, reuse the last draft if the user hasn't changed inputs

**Estimated savings**: 10-15% of total AI calls avoided

---

## Strategy 2: Downgrade Follow-Up Models (High Impact)

**Problem**: Follow-up emails (steps 2-4) use Gemini Flash, which is fine, but `nurture_sequence` (generating 4 emails at once) uses Gemini Pro unnecessarily.

**Solution**: Move `nurture_sequence` from `PRO_MODEL_TASKS` to Flash. It generates templated nurture emails, not deep analytical work. Also consider using `gemini-2.5-flash-lite` for:
- `intent_router` (simple JSON classification)
- `analyze_outgoing_email` (post-send stage detection)
- `pre_email_4_breakup` (short breakup emails)

**Estimated savings**: 20-30% cost reduction on those tasks (Pro is ~40x more expensive than Flash)

---

## Strategy 3: Batch Analysis Instead of Per-Lead (Medium Impact)

**Problem**: `extract_milestones_risks`, `extract_deal_factors`, and `recommend_next_steps` each make a separate Pro model call. For a single lead review, that's 3 Pro calls.

**Solution**: Combine these into a single "lead_deep_analysis" task with one Pro call that returns all three outputs in one JSON response. The prompts are already structured similarly.

**Estimated savings**: ~60% reduction on analysis calls (3 calls become 1)

---

## Strategy 4: Knowledge Base Query Caching (Medium Impact)

**Problem**: Every AI task that needs KB context runs a fresh `ilike` text search against `kb_chunks`. For the same lead, the same KB results return repeatedly.

**Solution**: Add an in-memory cache (or simple DB cache table) for KB query results, keyed by `(user_id, lead_id, query_hash)` with a 1-hour TTL. KB content rarely changes within an hour.

**Estimated savings**: Reduces DB load and latency (not direct AI cost, but reduces edge function execution time)

---

## Strategy 5: Skip Redundant Conversation Analysis (Medium Impact)

**Problem**: `conversation-analyze` runs on every new message, even if the previous analysis was minutes ago for the same conversation.

**Solution**: Add a cooldown check -- skip re-analysis if the last analysis for this conversation was less than 5 minutes ago and no new messages arrived since. The `message_window_end` field already tracks this.

**Estimated savings**: 15-25% of conversation analysis calls avoided in active chats

---

## Strategy 6: Rep Profile/Signature Preloading (Low Impact, Easy Win)

**Problem**: `automation-executor` fetches `rep_profiles` and `rep_signatures` separately for every lead in the batch, even though they're the same user.

**Solution**: Fetch once before the loop and reuse. This doesn't save AI costs but reduces execution time and DB calls per batch.

---

## Summary: Estimated Impact on Per-Lead Cost

| Strategy | Effort | Savings |
|---|---|---|
| Draft caching | Low | 10-15% fewer AI calls |
| Downgrade models for simple tasks | Low | 20-30% on affected tasks |
| Batch analysis (3-in-1) | Medium | ~60% on analysis calls |
| KB query caching | Medium | Latency + DB savings |
| Conversation analysis cooldown | Low | 15-25% on analysis calls |
| Rep profile preloading | Low | Execution time savings |

**Combined estimated reduction**: 25-40% overall AI cost, bringing the per-lead lifecycle cost from ~$0.045 down to ~$0.027-0.034.

---

## Technical Details

### Draft Caching Implementation
- Add a check in `automation-executor` before the AI call (around line 269):
  - Query `drafts` for `(lead_id, step_key, status='pending')` created within the last 24 hours
  - If found, reuse its `body_text` instead of calling `ai_task`
  
### Model Downgrade Changes
- In `ai_task/index.ts`, update the `PRO_MODEL_TASKS` array (line 1368) to remove `nurture_sequence`
- Create a new `LITE_MODEL_TASKS` array for `intent_router` and `analyze_outgoing_email`
- Add model selection logic: lite tasks use `gemini-2.5-flash-lite`, standard use `flash`, complex use `pro`

### Batch Analysis
- Create a new combined prompt `lead_deep_analysis` that merges `extract_milestones_risks`, `extract_deal_factors`, and `recommend_next_steps` into one call
- Return a combined JSON with all three sections
- Update the frontend callers to use the new unified task

### Conversation Analysis Cooldown  
- In `conversation-analyze/index.ts`, after fetching `priorAnalysis` (line 154), check if `priorAnalysis.created_at` is within the last 5 minutes
- If so, return the existing analysis without calling AI

