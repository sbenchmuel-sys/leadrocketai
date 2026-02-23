## Problem

The AI-generated reply to Dor Guzman is too long and salesy. Dor sent a short, enthusiastic "Would like to see what you offer" — a hot buying signal. The correct reply should be 2-3 sentences: acknowledge excitement, drop the calendar link, done. Instead, the system generated a 150-word pitch explaining Binah.ai's technology.

**Root causes:**

1. The `inbound_response` motion block in `ai_task` allows up to 150 words with vague structure guidance ("Provide one helpful detail"). For high-urgency, positive-sentiment inbound replies, this is way too loose.
2. The `generate-reply-suggestions` function has no word-count constraints at all — the "direct" style says "Short & direct" but doesn't enforce a ceiling.
3. Neither pipeline explicitly instructs the AI to **match the lead's energy/length** — a 12-word inbound should get a proportionally short reply.

## Plan

### 1. Tighten `inbound_response` motion block in `ai_task/index.ts`

Update the motion block (around line 296-308) to add urgency-aware length rules:

```text
=== MOTION: INBOUND RESPONSE ===
Objective:
Convert interest into a scheduled conversation.

Structure:
- Mirror the lead's energy and brevity.
- Acknowledge their interest in ONE short sentence.
- Provide the next step (meeting link, calendar, or specific question).
- Do NOT re-pitch or explain the product — the lead already showed interest.

Length:
- If the lead's message is under 30 words: reply in 40-60 words max.
- Otherwise: up to 100 words max.
- NEVER exceed 100 words for inbound responses unless the lead is asking questions from KB.
```

### 2. Add word-count caps to `generate-reply-suggestions/index.ts`

Update the prompt (around line 84-87) to enforce per-style limits:

```text
1. "direct" — 30-50 words max. Get to the point. One sentence of acknowledgment, one CTA.
2. "consultative" — 50-80 words max. Warm, ask one clarifying question, suggest next step.
3. "assertive" — 40-70 words max. Confident, lock down a time, mild urgency.
```

Also add this global instruction to the prompt:

```text
CRITICAL RULES:
- Do NOT re-explain the product or company value proposition. The lead already expressed interest.
- Match the lead's tone and brevity. Short inbound = short reply.
- If the lead is ready to meet, go straight to scheduling. No filler.
```

### 3. Include the actual inbound message text in the reply-suggestions prompt

Currently the prompt only passes `analysis.summary_short` as context. The AI never sees Dor's actual words. Add the latest inbound message body to the prompt context so the AI can match tone and length.

In `generate-reply-suggestions/index.ts`, after fetching `latestMsg`, also fetch its decrypted body (or plain body_text) and include it in the prompt as:

```text
- Latest inbound message: "{{message_text}}"
```

This requires fetching the message body. Since messages may be encrypted, fetch from `messages.body_text` (which contains the plaintext for non-encrypted channels) or call the decrypt utility for encrypted ones.

### Technical details

**Files to modify:**


| File                                                     | Change                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `supabase/functions/ai_task/index.ts`                    | Rewrite `inbound_response` motion block (~lines 296-308) with tighter word limits and anti-pitch rules |
| `supabase/functions/generate-reply-suggestions/index.ts` | Add word-count caps per style, add anti-pitch rules, include latest inbound message text in prompt     |


**No database changes needed.**

Both edge functions will be redeployed after changes.