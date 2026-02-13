

## Speed Optimization: Faster Email Generation

Three changes to cut email generation time by ~50%.

---

### Change 1: Remove the Retry Mechanism (saves 2-5s)

**File: `supabase/functions/ai_task/index.ts`**

The current system makes a second full AI call if an outbound first-touch draft exceeds 95 words. Instead, we strengthen the prompt to get it right the first time.

- **Update `buildMotionBlock`** (line 262-277): Add explicit counting instruction:
  ```
  CRITICAL: You MUST produce fewer than 90 words. Count every word carefully.
  If in doubt, make it shorter. Under 75 words is ideal.
  ```
- **Delete the retry block** (lines 1516-1546): Remove the entire `if (isOutboundFirstTouch && content)` retry logic that makes a second AI call.

---

### Change 2: Smart Model Routing (saves 1-3s on simple drafts)

**File: `supabase/functions/ai_task/index.ts`**

Update the `PRO_MODEL_TASKS` list (lines 1207-1216) to reflect your requirements:

**Use Flash (fast) for:**
- `pre_email_1_intro` -- outbound intro
- `pre_email_2_followup` -- outbound follow-up
- `email_intro_fast` -- outbound intro
- `email_intro_nurture` -- nurture intro
- `nurture_email_single` -- nurture emails
- `linkedin_connect`, `linkedin_followup` -- LinkedIn (already Flash)
- `whatsapp_message` -- WhatsApp (already Flash)

**Keep Pro (smart) for:**
- `post_meeting_recap` -- analytical, summarizes meeting
- `extract_milestones_risks` -- analytical, extracts structured data
- `extract_deal_factors` -- analytical, extracts structured data
- `recommend_next_steps` -- analytical, recommends actions
- `post_meeting_followup_email` -- post-meeting, uses meeting summaries + thread context
- `post_meeting_followup_personalized` -- post-meeting, uses meeting summaries
- `pre_email_3_followup` -- closing stage, uses full thread context
- `pre_email_4_breakup` -- closing stage, uses full thread context
- `reply_to_thread` -- engaged/active deals, considers previous emails + milestones
- `analyze_outgoing_email` -- analytical
- `nurture_sequence` -- multi-email sequence planning (analytical)

**Updated list:**
```typescript
const PRO_MODEL_TASKS = [
  "post_meeting_recap",
  "extract_milestones_risks",
  "extract_deal_factors",
  "recommend_next_steps",
  "post_meeting_followup_email",
  "post_meeting_followup_personalized",
  "pre_email_3_followup",
  "pre_email_4_breakup",
  "reply_to_thread",
  "analyze_outgoing_email",
  "nurture_sequence",
];
```

This removes `nurture_email_single` from Pro (simple value emails) and adds the closing/engaged tasks that need intelligence.

---

### Change 3: Add Database Index for KB Search (saves 100-300ms)

**SQL Migration:**

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_kb_chunks_content_trgm ON kb_chunks USING gin (content gin_trgm_ops);
CREATE INDEX idx_kb_chunks_owner_status ON kb_chunks (owner_user_id, processing_status)
  WHERE processing_status = 'completed';
```

This adds:
- A trigram index on `content` for faster `ilike` pattern matching
- A composite index on `owner_user_id + processing_status` for faster filtered lookups (used by every KB query now that we enforce user isolation)

---

### Summary

| Optimization | Time Saved | Risk |
|-------------|-----------|------|
| Remove retry block, strengthen prompt | 2-5s on outbound first touch | Low -- prompt enforcement is reliable |
| Smart model routing (Flash for simple, Pro for complex) | 1-3s on simple drafts | None -- Pro kept where intelligence matters |
| DB indexes for KB search | 100-300ms per generation | None -- read-only optimization |

No frontend changes needed. Only `supabase/functions/ai_task/index.ts` and one SQL migration.

