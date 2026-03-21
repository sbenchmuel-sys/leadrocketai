// ============================================
// AI TASK FRAMEWORKS & STYLE BLOCKS
// Extracted from ai_task/index.ts for deployment size limits
// ============================================

// ============================================
// CHANNEL MESSAGING FRAMEWORK ROUTER
// ============================================

export const CHANNEL_FRAMEWORKS: Record<string, string> = {
  email: `=== CHANNEL FRAMEWORK: EMAIL ===
Tone: Direct, human, zero fluff. Write like a busy person emailing another busy person.

Structure:
1. One sentence that proves you know who they are or what they do
2. One sentence that states why you're emailing — tied to a specific outcome
3. One question they can answer in 10 seconds

Constraints:
- Under 90 words for cold outbound
- No filler sentences ("I hope this finds you well", "I wanted to reach out")
- No feature lists
- No attachments in first email
- No calendar links unless explicitly provided
- One CTA only — always a question, never a statement`,

  sms: `=== CHANNEL FRAMEWORK: SMS ===
Tone: Texting a colleague. Ultra-direct.

Structure:
1. First name + one punchy line
2. One question

Constraints:
- MAXIMUM 160 characters total
- One sentence only
- No greeting beyond first name
- No sign-off or signature
- No links unless explicitly provided`,

  whatsapp: `=== CHANNEL FRAMEWORK: WHATSAPP ===
Tone: Casual, like a work friend texting.

Structure:
1. Hey [name], + context in one line
2. One question

Constraints:
- Maximum 50 words
- No formal sign-offs
- No signature blocks
- One emoji max, only if natural
- No subject line`,

  voice: `=== CHANNEL FRAMEWORK: VOICE ===
Tone: Confident, not scripted. Talk like a person, not a telemarketer.

Structure:
1. Why you're calling — one sentence
2. One question to start a conversation

Constraints:
- 3 bullet points max
- Each speakable in under 8 seconds
- No jargon, no marketing language`,
};

// ============================================
// SEQUENCE-AWARE MESSAGING FRAMEWORKS
// ============================================

type SequenceStepFramework = { structure: string; goal: string; constraints: string };

const EMAIL_SEQUENCE: Record<number, SequenceStepFramework> = {
  1: {
    structure: `1. One line that shows you know their business — reference their role, company, or industry specifically
2. One direct question about a problem they likely face`,
    goal: "Get a reply by being specific and human",
    constraints: "40–75 words. One CTA. No fluff. No calendar links. No features.",
  },
  2: {
    structure: `1. One-line callback to your previous email (not "just following up")
2. One new angle: a stat, trend, or specific challenge relevant to their role`,
    goal: "Add a reason to reply that wasn't in email 1",
    constraints: "Under 60 words. Different angle than email 1. One question.",
  },
  3: {
    structure: `1. Share one concrete result or example relevant to their situation
2. Ask if it's worth a conversation`,
    goal: "Give them proof, make it easy to say yes",
    constraints: "Under 70 words. One proof point. One soft CTA.",
  },
  4: {
    structure: `1. Acknowledge you've been reaching out
2. Ask if you should close the loop or if timing is just off`,
    goal: "Respectful exit that gets a response",
    constraints: "Under 55 words. No guilt. No fake urgency.",
  },
};

const SMS_SEQUENCE: Record<number, SequenceStepFramework> = {
  1: { structure: "One direct question about their business", goal: "Spark curiosity", constraints: "MAXIMUM 160 characters. No greeting beyond first name." },
  2: { structure: "One specific pain point question", goal: "Surface a real problem", constraints: "MAXIMUM 160 characters. No sign-off." },
  3: { structure: "One result or metric", goal: "Give them a reason to engage", constraints: "MAXIMUM 160 characters. Include a number." },
  4: { structure: "Should I close the loop?", goal: "Clean exit", constraints: "MAXIMUM 160 characters. No guilt." },
};

const WHATSAPP_SEQUENCE: Record<number, SequenceStepFramework> = {
  1: { structure: `Hey [name], + one direct question`, goal: "Start a conversation", constraints: "Maximum 50 words. Casual. No sign-off." },
  2: { structure: `Quick follow-up + one new angle`, goal: "New reason to reply", constraints: "Maximum 50 words. Different from msg 1." },
  3: { structure: `One result + worth chatting?`, goal: "Proof point", constraints: "Maximum 50 words. Keep it light." },
  4: { structure: `Should I stop reaching out?`, goal: "Clean exit", constraints: "Maximum 40 words. No pressure." },
};

const VOICE_SEQUENCE: Record<number, SequenceStepFramework> = {
  1: { structure: `1. Why you're calling\n2. One question`, goal: "Earn 30 seconds", constraints: "2-3 bullets. Natural language." },
  2: { structure: `1. Specific challenge for their role\n2. How are you handling it?`, goal: "Surface pain", constraints: "2-3 bullets. No jargon." },
  3: { structure: `1. Quick result mention\n2. Worth exploring?`, goal: "Credibility", constraints: "3 bullets max." },
  4: { structure: `1. Acknowledge attempts\n2. Wrong person or wrong time?`, goal: "Redirect or close", constraints: "2 bullets. Professional." },
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
  return `=== SEQUENCE STEP ${step} FRAMEWORK (${channel.toUpperCase()}) ===\nGoal: ${fw.goal}\n\nStructure:\n${fw.structure}\n\nConstraints:\n${fw.constraints}`;
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
=== COLD OUTREACH STYLE: DIRECT & BLUNT ===
Principle: Write like a busy founder emailing another busy person. No marketing. No fluff.

Structure:
- 2-4 sentences total
- First sentence: prove you know who they are
- Last sentence: one question they can answer quickly

Rules:
- Get to the point in the first line
- No "I wanted to reach out" or "I hope this finds you well"
- No company history or product descriptions
- No feature lists
- No calendar links in first email
- One question only as CTA

Psychology:
- Specificity = credibility
- Brevity = respect for their time
- Questions > statements
`;

const COLD_OUTREACH_SAAS_BLOCK = `
=== COLD OUTREACH STYLE: B2B SAAS DIRECT ===
Length: Under 75 words.
Opening:
- State what you noticed about their company or stack
- OR name a specific problem their role deals with
Core:
- One sentence tying your outreach to a measurable outcome
- No feature lists
CTA:
- "Is this something you're dealing with?"
- "Worth a 10-min look?"
- "Am I way off base here?"
Avoid:
- "Revolutionary" / "Best-in-class" / "Cutting-edge"
- Marketing language of any kind
`;

const COLD_OUTREACH_MEDICAL_BLOCK = `
=== COLD OUTREACH STYLE: MEDICAL DEVICE DIRECT ===
Length: Under 90 words.
Opening:
- Professional but direct. State your reason for reaching out.
Core:
- One clinical or operational benefit
- No exaggerated claims
CTA:
- "Would it make sense to compare notes?"
- "Who handles this at your facility?"
Avoid:
- Urgency pressure
- Sales-heavy tone
`;

const COLD_OUTREACH_GENERAL_BLOCK = `
=== COLD OUTREACH STYLE: GENERAL B2B DIRECT ===
Length: Under 75 words. Target 50 words.
Opening:
- Reference their specific role, company, or industry in one sentence
- OR ask a direct question about a real challenge they face
- NEVER start with abstract questions or philosophical openers
Core:
- One sentence connecting your outreach to their world — not yours
- No features, no pitching
CTA:
- One question. Keep it dead simple.
- "Is this on your radar?"
- "Worth a quick chat?"
- "Am I off base?"
Avoid:
- "What if" philosophical questions
- Filler sentences that add no information
- Any sentence that could apply to any company in any industry
- Marketing buzzwords
`;

const PLAYBOOK_OUTREACH_BLOCKS: Record<string, string> = {
  b2b_saas: COLD_OUTREACH_SAAS_BLOCK,
  medical_device_rep: COLD_OUTREACH_MEDICAL_BLOCK,
  general_sales: COLD_OUTREACH_GENERAL_BLOCK,
};

export function getColdOutreachBlock(playbookId: string): string {
  return PLAYBOOK_OUTREACH_BLOCKS[playbookId] || COLD_OUTREACH_STYLE_BLOCK;
}

// Reply optimization
export const REPLY_PATTERNS_BLOCK = `
=== CTA PATTERNS (use ONE per email) ===
- Direct: "Is this relevant for you right now?"
- Permission: "Should I stop reaching out?"
- Binary: "Worth a chat — yes or no?"
- Timing: "Bad timing, or just not relevant?"
Rules: ONE per email. Always the last sentence.
`;

// Breakup closers
export const BREAKUP_CLOSERS: Record<string, string> = {
  b2b_saas: `Breakup: "Haven't heard back — should I close the loop?"`,
  general_sales: `Breakup: "Should I stop reaching out, or is it just timing?"`,
};

// ============================================
// EMAIL FRAMEWORK ROUTER
// ============================================

export type EmailFramework = "curiosity" | "observation" | "hypothesis" | "ultra_short";

export const EMAIL_FRAMEWORK_BLOCKS: Record<EmailFramework, string> = {
  curiosity: `=== MESSAGE FRAMEWORK: DIRECT QUESTION ===
Opening: Ask ONE specific question about their business. The question must reference their actual role, industry, or company.
The question must be something only THEY can answer — not a generic question you could ask anyone.

GOOD:
- "How are you handling [specific process] at [company] right now?"
- "What's your biggest headache with [thing their role deals with]?"
- "Are you still running [process] manually at [company]?"

BAD (NEVER use):
- "What if the biggest growth lever was X?"
- "Have you considered optimizing your operations?"
- Any question that doesn't reference their specific situation`,

  observation: `=== MESSAGE FRAMEWORK: SIGNAL-BASED ===
Opening: Reference ONE real signal from Sales Signals. State it as a fact, then ask a question.
Must use actual data — never fabricate.
Pattern: "Saw [signal]. How is that affecting [related area]?"`,

  hypothesis: `=== MESSAGE FRAMEWORK: CHALLENGE ===
Opening: Name a specific problem their role/industry faces. Be bold but accurate.
Frame it as something you're seeing, then ask if it's true for them.
Pattern: "Most [role] at [industry] companies struggle with [specific thing]. Is that true at [company]?"`,

  ultra_short: `=== MESSAGE FRAMEWORK: ULTRA-SHORT ===
Total email: 2-3 sentences. No greeting beyond first name. No sign-off beyond name.
Pattern: "Hi [name], [one line of context]. [one question]?"`,
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
Objective: Get a reply. Period. Not to educate, not to pitch, not to impress.

WORD COUNT: Under 75 words. Ideally under 60. Count them.

RULES:
- 2-3 short paragraphs max
- First sentence must prove you know who they are
- Last sentence must be a question
- No feature lists
- No attachments
- No calendar links
- No company history

Knowledge usage:
- Use ONLY to pick the right angle. Never describe your product.`;
  }

  if (motion === "outbound_prospecting") {
    return `=== MOTION: OUTBOUND FOLLOW-UP ===
Objective: Give them a new reason to reply.

RULES:
- Under 70 words
- Different angle than previous emails
- One new insight or observation
- One CTA only`;
  }

  if (motion === "post_meeting") {
    return `=== MOTION: POST-MEETING ===
Objective: Move the deal forward with a clear next step.

Structure:
- Quick thank-you (one line)
- Key takeaway or agreed action item
- Clear next step with a date/time if possible

Length: 80–150 words.`;
  }

  if (motion === "closing") {
    return `=== MOTION: CLOSING ===
Objective: Drive to commitment on outstanding decisions.

Structure:
- Reference the specific decision pending
- Address any outstanding concerns
- Clear, time-bound next step

Length: 80–150 words. Be direct about what needs to happen next.`;
  }

  if (motion === "inbound_response") {
    return `=== MOTION: INBOUND RESPONSE ===
Objective: Convert interest into a scheduled conversation.

Rules:
- Mirror their energy and brevity
- Acknowledge their interest in ONE sentence
- Give them a next step immediately
- Do NOT re-pitch or explain the product

Length: Under 80 words.`;
  }

  if (motion === "nurture") {
    return `=== MOTION: NURTURE ===
Objective: Stay relevant without being annoying.

Rules:
- Share one useful insight
- One soft CTA
- No urgency, no pressure

Length: 60–100 words.`;
  }

  return "";
}

export function buildStyleModifier({ motion, first_touch, outbound_style }: { motion: string; first_touch: boolean; outbound_style: string }): string {
  if (motion !== "outbound_prospecting" || !first_touch) {
    return "";
  }

  if (outbound_style === "high_reply") {
    return `=== OUTBOUND STYLE: HIGH REPLY ===
Adjustment:
- Start with a direct question or bold statement
- Skip pleasantries entirely
- Create mild tension around a specific problem
- Keep opening under 15 words

Do NOT increase word count or override motion rules.`;
  }

  return `=== OUTBOUND STYLE: STANDARD ===
Adjustment:
- Direct opening. State relevance immediately.
- No gimmicks. No filler.

Do NOT override motion rules.`;
}
