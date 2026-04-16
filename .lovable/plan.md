
## Style Learning Engine (Email, SMS, WhatsApp)

### Goal
The platform learns each rep's writing style across **all text channels** (email, SMS, WhatsApp) and injects it as soft constraints into AI draft generation — improving over time with every sent message and explicit feedback.

---

### 1. Data Model (3 new tables)

**`style_examples`** — stores sent/liked/disliked messages
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| user_id | uuid FK auth.users | per-user learning |
| workspace_id | uuid FK workspaces | RLS scoping |
| channel | text | `email`, `sms`, `whatsapp` |
| motion_type | text | `outbound_cold`, `reply_to_thread`, `nurture`, `follow_up` |
| subject | text | nullable (email only) |
| body_text | text | the actual message |
| feedback | text | `sent` (passive), `liked`, `disliked` |
| feedback_comment | text | optional user note on dislike |
| style_features_json | jsonb | AI-extracted features (populated async) |
| created_at | timestamptz | |

**`user_style_profiles`** — condensed style guide per user+channel+motion
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| user_id | uuid FK | |
| workspace_id | uuid FK | |
| channel | text | `email`, `sms`, `whatsapp` |
| motion_type | text | `outbound_cold`, `reply_to_thread`, etc. |
| profile_json | jsonb | synthesized style rules |
| example_count | int | how many examples fed into this profile |
| last_synthesized_at | timestamptz | |
| created_at / updated_at | timestamptz | |

Unique constraint: `(user_id, channel, motion_type)`

**`user_style_directives`** — free-text anchor per user
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| user_id | uuid FK | |
| workspace_id | uuid FK | |
| directive_text | text | e.g. "I write like a busy founder — no fluff" |
| created_at / updated_at | timestamptz | |

---

### 2. Style Feature Extraction (per channel)

New AI task `extract_style_features` in `ai_task` edge function. Channel-aware feature schema:

**Email features:**
```json
{
  "opening_style": "direct_question",
  "closing_style": "soft_cta",
  "tone_markers": ["informal", "confident"],
  "avg_paragraph_count": 2,
  "uses_bullets": false,
  "personalization_density": "high",
  "cta_pattern": "question_based",
  "signature_style": "first_name_only"
}
```

**SMS features:**
```json
{
  "avg_length_chars": 120,
  "uses_emoji": true,
  "tone_markers": ["casual", "urgent"],
  "cta_pattern": "link_drop",
  "greeting_style": "none"
}
```

**WhatsApp features:**
```json
{
  "avg_length_chars": 200,
  "uses_emoji": true,
  "multi_message": false,
  "tone_markers": ["friendly", "professional"],
  "cta_pattern": "direct_ask",
  "greeting_style": "first_name"
}
```

---

### 3. Profile Synthesis

New edge function **`synthesize-style-profile`**:
- Triggered after every 5 new examples for a given `(user, channel, motion)` combo
- Uses rolling window of last **50 examples** (weighted: disliked×3, liked×2, sent×1)
- Merges with `user_style_directives` as anchoring constraint
- Outputs a condensed `profile_json` like:

```json
{
  "channel": "email",
  "motion": "outbound_cold",
  "preferred_opening": "direct_question (68%)",
  "tone": "direct, slightly informal",
  "structure": "2-3 short paragraphs, no bullets",
  "cta_style": "question_based, never 'let me know'",
  "anti_patterns": ["never uses 'I hope this finds you well'", "avoids exclamation marks"],
  "personalization": "always references company-specific context in first sentence",
  "example_count": 23,
  "confidence": "high"
}
```

---

### 4. Injection into Draft Generation

Modify `ai_task/index.ts` — for tasks `outbound_sequence`, `reply_to_thread`, `sms_message`, `whatsapp_reply`:
1. Determine channel + motion from task context
2. Fetch matching `user_style_profiles` row
3. If found (and `example_count >= 5`), append style block to system prompt:
```
## Your Writing Style (learned from user's past messages)
{profile_json formatted as bullet rules}
These are SOFT constraints. Follow them unless they conflict with the task objective.
```
4. If `user_style_directives` exists, prepend it as highest-priority anchor

---

### 5. Capture Points (Frontend)

**Passive capture (all channels):**
- `ReplyComposer.tsx` — after successful send on email, WhatsApp, or SMS
- `SendEmailButton.tsx` — after outbound email send
- `automation-executor` — after automated sends (tagged `feedback: 'auto_sent'`)

**Explicit feedback:**
- Add 👍/👎 buttons to AI suggestion chips in `ReplyComposer.tsx`
- 👎 opens a small text input for optional comment
- Both insert into `style_examples` with `feedback: 'liked'|'disliked'`

---

### 6. Settings UI — `WritingStyleCard.tsx`

Added to Settings page:
- **Style directive** — editable textarea ("Describe your writing voice…")
- **Detected traits** — read-only display of current profile per channel/motion
- **Learning stats** — "23 emails learned, 8 WhatsApp, 3 SMS"
- **Pause learning** toggle — stops passive capture
- **Reset style** button — deletes all examples + profiles, confirms with dialog
- **Channel tabs**: Email | SMS | WhatsApp — each showing motion-specific profiles

---

### 7. Safety & Drift Prevention

| Risk | Mitigation |
|------|-----------|
| Style drift over time | Rolling 50-example window, older examples age out |
| Bad examples pollute profile | Disliked examples create anti-patterns, not positive rules |
| Profile goes off track | Reset button clears everything; Pause toggle stops capture |
| Conflicting motion styles | Separate profiles per (channel, motion) — outreach ≠ reply |
| Low confidence early | Profile not injected until ≥5 examples for that combo |
| Over-constraining the AI | Rules injected as "SOFT constraints" — task objective wins |

---

### 8. Files Changed

| File | Change |
|------|--------|
| **Migration** | Create 3 tables + RLS policies + unique constraints |
| `supabase/functions/ai_task/index.ts` | Add `extract_style_features` task; inject style profile into all draft tasks |
| `supabase/functions/synthesize-style-profile/index.ts` | **New** — profile synthesis logic |
| `src/components/inbox/ReplyComposer.tsx` | Passive capture on send (all channels); 👍/👎 on suggestion chips |
| `src/components/settings/WritingStyleCard.tsx` | **New** — style management UI with channel tabs |
| `src/pages/Settings.tsx` | Add WritingStyleCard |

### 9. Implementation Order
1. DB migration (tables + RLS)
2. `extract_style_features` task in ai_task
3. `synthesize-style-profile` edge function
4. Capture hooks in ReplyComposer + SendEmailButton
5. Style injection in ai_task draft generation
6. WritingStyleCard settings UI
7. Test end-to-end with email, then SMS, then WhatsApp
