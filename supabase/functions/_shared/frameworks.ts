// ============================================
// AI TASK FRAMEWORKS & STYLE BLOCKS
// Extracted from ai_task/index.ts for deployment size limits
// ============================================

// ============================================
// CHANNEL MESSAGING FRAMEWORK ROUTER
// ============================================

export const CHANNEL_FRAMEWORKS: Record<string, string> = {
  email: `=== CHANNEL FRAMEWORK: EMAIL ===
Structure (follow this order):
1. Personalized observation — reference something specific about the lead or company
2. Business problem — articulate a clear pain point or challenge they likely face
3. Value proposition — one concise outcome or benefit (not a feature list)
4. Soft call to action — a low-friction question or next step

Constraints:
- 90–150 words
- Professional, structured tone
- Short paragraphs (1–3 sentences each)
- One CTA only
- No attachments in first email
- No calendar links unless explicitly provided`,

  sms: `=== CHANNEL FRAMEWORK: SMS ===
Structure (follow this order):
1. Curiosity hook — one compelling statement that creates intrigue
2. Quick question — a single low-friction question as CTA

Constraints:
- MAXIMUM 160 characters total (this is a hard limit)
- One sentence only
- Direct, concise tone
- No greeting beyond first name
- No sign-off or signature
- No links unless explicitly provided
- No emojis unless natural to the context`,

  whatsapp: `=== CHANNEL FRAMEWORK: WHATSAPP ===
Structure (follow this order):
1. Friendly opener — casual greeting with first name
2. Short context — 1–2 sentences explaining why you're reaching out
3. Question — a conversational question to invite a reply

Constraints:
- 1–3 short paragraphs maximum
- Casual, conversational tone (like texting a colleague)
- No formal sign-offs (no "Best regards", no signature blocks)
- Maximum 60 words
- One emoji max, only if natural
- No subject line
- No bracketed placeholders`,

  voice: `=== CHANNEL FRAMEWORK: VOICE ===
Structure (follow this order):
1. Reason for call — why you're calling in one sentence
2. Credibility context — brief mention of relevant experience, client, or insight
3. Discovery question — an open-ended question to start a conversation

Constraints:
- Use natural spoken language (not written/formal prose)
- Format as a short talk track with bullet points or brief sentences
- 3–5 bullet points maximum
- Each bullet should be speakable in under 10 seconds
- No jargon, no marketing language
- Include a suggested objection response if appropriate`,
};

// ============================================
// SEQUENCE-AWARE MESSAGING FRAMEWORKS
// ============================================

type SequenceStepFramework = { structure: string; goal: string; constraints: string };

const EMAIL_SEQUENCE: Record<number, SequenceStepFramework> = {
  1: {
    structure: `1. Personalized observation — reference something specific about the lead or company
2. Quick context — one sentence on why you're reaching out
3. Question — a curiosity-driven question to invite a reply`,
    goal: "Spark curiosity and earn a reply",
    constraints: "Maximum 120 words. One CTA only. No attachments. No calendar links.",
  },
  2: {
    structure: `1. Industry insight — share a relevant trend or data point
2. Business problem — connect the insight to a likely challenge they face
3. Question — ask if they're experiencing this or exploring solutions`,
    goal: "Create problem awareness",
    constraints: "90–150 words. Reference a specific insight. One CTA only.",
  },
  3: {
    structure: `1. Proof or example — mention a relevant result, case study, or client outcome
2. Value proposition — tie the proof to a clear benefit for their situation
3. Soft CTA — suggest a next step without pressure`,
    goal: "Build credibility and demonstrate value",
    constraints: "90–150 words. One concrete proof point. One soft CTA.",
  },
  4: {
    structure: `1. Polite close — acknowledge you've reached out multiple times
2. Low pressure message — no guilt, no urgency tricks
3. Optional reconnect — leave the door open for future contact`,
    goal: "Respectful breakup that preserves the relationship",
    constraints: "60–100 words. No guilt language. No fake urgency. Warm and professional.",
  },
};

const SMS_SEQUENCE: Record<number, SequenceStepFramework> = {
  1: { structure: "Curiosity question — one compelling question that creates intrigue", goal: "Spark curiosity", constraints: "MAXIMUM 160 characters. One sentence. Direct tone. No greeting beyond first name." },
  2: { structure: "Problem question — ask about a specific pain point relevant to their role", goal: "Surface a problem", constraints: "MAXIMUM 160 characters. One sentence. No sign-off." },
  3: { structure: "Short insight — share one concise data point or outcome", goal: "Provide value in minimal space", constraints: "MAXIMUM 160 characters. One sentence. Include a number or metric if possible." },
  4: { structure: "Soft close — respectful final nudge or permission to close the loop", goal: "Breakup without pressure", constraints: "MAXIMUM 160 characters. No guilt. Warm tone." },
};

const WHATSAPP_SEQUENCE: Record<number, SequenceStepFramework> = {
  1: { structure: `1. Friendly opener — casual greeting with first name\n2. Question — a conversational question to invite a reply`, goal: "Start a conversation naturally", constraints: "Maximum 60 words. Casual tone. One emoji max. No sign-off." },
  2: { structure: `1. Short insight — one relevant trend or observation\n2. Question — ask if this resonates with their situation`, goal: "Share value and keep the conversation going", constraints: "Maximum 60 words. Conversational. No formal language." },
  3: { structure: `1. Proof — mention a relevant result or example briefly\n2. Question — ask if they'd like to learn more`, goal: "Build credibility through a real example", constraints: "Maximum 60 words. Keep it light. No marketing speak." },
  4: { structure: `1. Soft close — friendly message acknowledging the outreach\n2. Open door — leave room for future contact`, goal: "Respectful close that preserves the relationship", constraints: "Maximum 50 words. Warm. No pressure." },
};

const VOICE_SEQUENCE: Record<number, SequenceStepFramework> = {
  1: { structure: `1. Reason for call — one sentence on why you're calling\n2. Discovery question — an open-ended question to start a conversation`, goal: "Earn 30 more seconds of attention", constraints: "3–4 bullet points. Natural spoken language. Under 10 seconds per bullet." },
  2: { structure: `1. Problem framing — articulate a challenge relevant to their role\n2. Bridge question — ask how they're currently handling it`, goal: "Surface a pain point through conversation", constraints: "3–4 bullet points. No jargon. Conversational phrasing." },
  3: { structure: `1. Proof — mention a relevant client result or outcome\n2. Value bridge — connect the proof to their likely situation\n3. Next step question — ask if it's worth exploring`, goal: "Demonstrate credibility and propose next step", constraints: "4–5 bullet points. Include one specific metric or name if available." },
  4: { structure: `1. Permission close — acknowledge multiple attempts respectfully\n2. Final question — ask if timing is wrong or if there's someone better to speak with`, goal: "Respectful close or redirect", constraints: "3 bullet points max. No guilt. Professional warmth." },
};

const SEQUENCE_FRAMEWORKS: Record<string, Record<number, SequenceStepFramework>> = {
  email: EMAIL_SEQUENCE,
  sms: SMS_SEQUENCE,
  whatsapp: WHATSAPP_SEQUENCE,
  voice: VOICE_SEQUENCE,
};

// Map task_type to implicit sequence step
const TASK_TO_SEQUENCE_STEP: Record<string, number> = {
  pre_email_1_intro: 1,
  email_intro_fast: 1,
  email_intro_nurture: 1,
  inbound_intro: 1,
  re_engagement_intro: 1,
  pre_email_2_followup: 2,
  pre_email_3_followup: 3,
  pre_email_4_breakup: 4,
};

export function resolveSequenceStep(task: string, payloadStep?: number | string): number | null {
  if (payloadStep != null) {
    const n = Number(payloadStep);
    if (n >= 1 && n <= 4) return n;
  }
  return TASK_TO_SEQUENCE_STEP[task] ?? null;
}

export function getSequenceFramework(channel: string, step: number): string {
  const channelSeq = SEQUENCE_FRAMEWORKS[channel];
  if (!channelSeq) return "";
  const fw = channelSeq[step];
  if (!fw) return "";
  return `=== SEQUENCE STEP ${step} FRAMEWORK (${channel.toUpperCase()}) ===\nGoal: ${fw.goal}\n\nStructure (follow this order):\n${fw.structure}\n\nConstraints:\n${fw.constraints}`;
}

export const CHANNEL_FRAMEWORK_EXEMPT_TASKS = new Set([
  "intent_router", "extract_milestones_risks", "extract_deal_factors",
  "recommend_next_steps", "lead_deep_analysis", "analyze_outgoing_email",
  "match_email_to_milestones", "dedupe_milestones", "whatsapp_classify_intent",
  "followup_sequence_4", "post_meeting_recap", "nurture_sequence",
]);

export function resolveChannel(task: string, payloadChannel?: string): string {
  if (task.startsWith("whatsapp_")) return "whatsapp";
  if (task.startsWith("linkedin_")) return "email";
  if (task === "shorten_draft") return payloadChannel || "email";
  return payloadChannel || "email";
}

export function getChannelFramework(task: string, channel: string): string {
  if (CHANNEL_FRAMEWORK_EXEMPT_TASKS.has(task)) return "";
  return CHANNEL_FRAMEWORKS[channel] || "";
}

// ============================================
// COLD OUTREACH STYLE BLOCKS
// ============================================

export const COLD_OUTREACH_STYLE_BLOCK = `
=== COLD OUTREACH STYLE: HIGH REPLY RATE MODE ===
Structure:
- 3-6 sentences max
- 1 idea per paragraph
- No large blocks of text
- No attachments in first email
Opening:
- Personalized observation OR relevant trigger OR specific problem hypothesis
Core:
- One clear outcome
- One short proof point (metric, client, example)
- No feature list
CTA:
- Micro-commitment only
- Yes/No question OR "Worth a quick look?" OR "Open to a short conversation?"
Avoid:
- Long intros, company history, multiple CTAs
- Calendar links in first email
- Generic "just checking in"
Psychology:
- Reduce pressure, make reply easy, signal relevance, leave room for correction
`;

const COLD_OUTREACH_SAAS_BLOCK = `
=== COLD OUTREACH STYLE: B2B SAAS HIGH REPLY ===
Length: Under 120 words.
Opening:
- Reference something specific about their company
- OR hypothesize a clear bottleneck
- Example: "Noticed you're hiring for X…" / "Saw you recently launched Y…"
Core:
- Tie product to one measurable outcome
- Use one concrete metric
- Avoid listing features
CTA:
- "Is this something you're exploring?"
- "Would a 15-min chat make sense?"
- "Worth sharing a quick breakdown?"
Avoid:
- Overly polished marketing language
- Buzzwords like "Revolutionary" / "Best-in-class"
Psychological triggers:
- Relevance, specificity, low friction, curiosity gap
`;

const COLD_OUTREACH_MEDICAL_BLOCK = `
=== COLD OUTREACH STYLE: MEDICAL DEVICE HIGH REPLY ===
Length: Under 130 words.
Opening:
- Professional introduction
- Clear context (why reaching out)
Core:
- One clinical or operational benefit
- Avoid exaggerated claims
- Reference use case
CTA:
- "Would it make sense to share more details?"
- "Open to a brief discussion?"
- "Who would be best to speak with?"
Avoid:
- Urgency pressure
- Sales-heavy tone
- Aggressive follow-ups
Psychological triggers:
- Professional credibility, safety, process alignment
`;

const COLD_OUTREACH_GENERAL_BLOCK = `
=== COLD OUTREACH STYLE: GENERAL B2B HIGH REPLY ===
Length: Under 90 words. Target 65 words.
Opening:
- Reference something specific about their role, company, or industry
- OR ask a direct question about a likely challenge they face
- NEVER start with abstract/philosophical questions
Core:
- One sentence connecting your outreach to a clear business outcome
- No feature lists, no product pitches
CTA:
- One simple question that's easy to reply to
- "Is this something you're dealing with?"
- "Worth a quick chat?"
Avoid:
- Abstract "What if" questions
- Vague value propositions
- Marketing language
- Long intros or company history
Psychological triggers:
- Specificity, relevance, low friction, conversational tone
`;

const PLAYBOOK_OUTREACH_BLOCKS: Record<string, string> = {
  b2b_saas: COLD_OUTREACH_SAAS_BLOCK,
  medical_device_rep: COLD_OUTREACH_MEDICAL_BLOCK,
  general_sales: COLD_OUTREACH_GENERAL_BLOCK,
};

export function getColdOutreachBlock(playbookId: string): string {
  return PLAYBOOK_OUTREACH_BLOCKS[playbookId] || COLD_OUTREACH_STYLE_BLOCK;
}

// Psychological reply patterns
export const REPLY_PATTERNS_BLOCK = `
=== REPLY OPTIMIZATION PATTERNS ===
Rotate one of these CTA patterns per email to maximize reply probability:
Permission-Based: "If this isn't relevant, feel free to say so — I'll close the loop."
Soft Assumption: "If this is already handled internally, happy to step aside."
Binary Micro-CTA: "Would you say this is: A) Relevant now B) Worth revisiting later C) Not a priority"
Curiosity Close: "Worth sharing how we've approached this with similar teams?"
Rules:
- Use ONE pattern per email, do not stack
- Match pattern to deal stage
- Keep the CTA as the final sentence
`;

// Playbook-specific breakup closers
export const BREAKUP_CLOSERS: Record<string, string> = {
  b2b_saas: `Breakup style: "I haven't heard back, so I'll assume this isn't a priority right now. If I'm wrong, happy to reconnect. Either way — appreciate the time."`,
  general_sales: `Breakup style: "Seems like timing may not be right. Should I close the loop for now?"`,
};

// ============================================
// EMAIL FRAMEWORK ROUTER
// ============================================

export type EmailFramework = "curiosity" | "observation" | "hypothesis" | "ultra_short";

export const EMAIL_FRAMEWORK_BLOCKS: Record<EmailFramework, string> = {
  curiosity: `=== MESSAGE FRAMEWORK: CURIOSITY ===
Opening: Start with a SHORT question that creates genuine curiosity about their specific situation.
The question MUST reference their industry, role, or company directly — never be abstract or philosophical.
Do NOT answer the question yourself. Let them respond.
Do NOT use "What if..." constructions. Use direct, specific questions instead.
GOOD examples:
- "Are your printing teams still manually tracking reprint rates?"
- "How are you handling turnaround guarantees when order volume spikes?"
- "Curious — what's your biggest bottleneck during peak season?"
BAD examples (NEVER use these patterns):
- "What if the biggest growth lever for X isn't Y — it's Z?"
- "What if transforming existing operations was the key?"
- Any philosophical/abstract question that could apply to any industry`,

  observation: `=== MESSAGE FRAMEWORK: OBSERVATION ===
Opening: Reference a REAL signal or activity about their company.
The observation must come from the Sales Signals provided. Do NOT fabricate observations.
Connect the observation to a relevant question or insight.
Example pattern: "Noticed [specific signal]. Curious how that's affecting [related area]?"`,

  hypothesis: `=== MESSAGE FRAMEWORK: HYPOTHESIS ===
Opening: Propose a likely bottleneck or challenge they face based on their industry/role.
The hypothesis must be specific and testable — something they can confirm or deny.
Frame it as a question, not a statement.
Example pattern: "Most [role] at [industry type] companies tell us [specific bottleneck]. Is that true for [company]?"`,

  ultra_short: `=== MESSAGE FRAMEWORK: ULTRA-SHORT ===
Structure: 2-3 sentences MAXIMUM. No paragraphs. No greeting beyond first name.
Get to the point in one breath. One question only.
Example pattern: "Hi [name], [one sentence context]. [one question]?"`,
};

export function selectEmailFramework(
  signals: { type: string; description: string }[],
  industry?: string,
  leadContext?: string,
): EmailFramework {
  if (signals && signals.length > 0) {
    const actionableTypes = ["hiring", "funding", "expansion", "product_launch", "new_partnership", "press_coverage"];
    if (signals.some(s => actionableTypes.includes(s.type))) return "observation";
  }
  if (industry || leadContext) {
    const ctx = `${industry || ""} ${leadContext || ""}`.toLowerCase();
    const painIndicators = ["manual", "spreadsheet", "legacy", "outdated", "inefficient", "scaling", "bottleneck", "turnover", "compliance"];
    if (painIndicators.some(p => ctx.includes(p))) return "hypothesis";
  }
  return "curiosity";
}

export function getEmailFrameworkBlock(framework: EmailFramework): string {
  return EMAIL_FRAMEWORK_BLOCKS[framework] || EMAIL_FRAMEWORK_BLOCKS.curiosity;
}

// ============================================
// MOTION & STYLE BLOCKS
// ============================================

export function buildMotionBlock({ motion, first_touch }: { motion: string; first_touch: boolean }): string {
  if (motion === "outbound_prospecting" && first_touch) {
    return `=== MOTION: OUTBOUND FIRST TOUCH ===
Objective:
Trigger a reply. Not to close. Not to explain fully.

CRITICAL: You MUST produce fewer than 90 words. Count every word carefully.
If in doubt, make it shorter. Under 75 words is ideal.

STRICT STRUCTURE RULES:
- ABSOLUTE Maximum 90 words. No exceptions.
- Maximum 5 short paragraphs.
- One idea only.
- One CTA only (a simple question, never a calendar link).
- No feature lists.
- No attachments.
- No calendar links.

Knowledge usage:
- Use only for positioning alignment.
- Do NOT include case studies or long explanations.`;
  }

  if (motion === "outbound_prospecting") {
    return `=== MOTION: OUTBOUND FOLLOW-UP ===
Objective:
Re-engage the prospect with a new angle or value point.

STRUCTURE RULES:
- Maximum 120 words.
- Reference previous outreach naturally.
- One new insight or angle per email.
- One CTA only.`;
  }

  if (motion === "inbound_response") {
    return `=== MOTION: INBOUND RESPONSE ===
Objective:
Convert interest into a scheduled conversation.

Structure:
- Mirror the lead's energy and brevity.
- Acknowledge their interest in ONE short sentence.
- Provide the next step (meeting link, calendar, or specific question).
- Do NOT re-pitch or explain the product — the lead already showed interest.
- Do NOT describe your company's technology or value proposition.

Length:
- If the lead's message is under 30 words: reply in 40-60 words max.
- Otherwise: up to 100 words max.
- NEVER exceed 100 words for inbound responses unless the lead is asking detailed questions that require KB context.`;
  }

  if (motion === "nurture") {
    return `=== MOTION: NURTURE ===
Objective:
Maintain relevance without pressure.

Structure:
- Short value insight.
- Soft CTA.
- No urgency.

Length:
- 60–120 words.`;
  }

  return "";
}

export function buildStyleModifier({ motion, first_touch, outbound_style }: { motion: string; first_touch: boolean; outbound_style: string }): string {
  if (motion !== "outbound_prospecting" || !first_touch) {
    return "";
  }

  if (outbound_style === "high_reply") {
    return `=== OUTBOUND STYLE: HIGH REPLY ===
Opening Adjustment:
- Begin with a short disarming phrase (e.g., "Quick one —") OR start with a focused question.
- Prefer question-first framing.
- Keep opening under 2 short lines.
- Introduce mild tension around a likely pain point.

Do NOT:
- Increase total word count.
- Add humor unless clearly appropriate.
- Change compliance tone.
- Override motion structure rules.`;
  }

  return `=== OUTBOUND STYLE: STANDARD ===
Opening Adjustment:
- Professional, direct opening.
- State relevance clearly in the first sentence.
- No gimmicks.

Do NOT:
- Override motion structure rules.
- Increase total word count.`;
}
