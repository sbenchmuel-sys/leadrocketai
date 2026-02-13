import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Tasks that require semantic knowledge search
const KNOWLEDGE_SEARCH_TASKS = [
  "email_intro_fast",
  "email_intro_nurture",
  "followup_sequence_4",
  "post_meeting_recap",
  "answer_questions",
  "pre_email_1_intro",
  "pre_email_2_followup",
  "pre_email_3_followup",
  "pre_email_4_breakup",
  "post_meeting_followup_personalized",
  "nurture_sequence",
  "nurture_email_single",
  "post_meeting_followup_email",
  "extract_milestones_risks",
  "extract_deal_factors",
  "recommend_next_steps",
  "linkedin_followup",
  "reply_to_thread",
];

// Function to get knowledge context using text-based search (no embeddings required)
async function getTextBasedKnowledgeContext(
  queryText: string,
  supabaseUrl: string,
  supabaseServiceKey: string,
  userId: string,
  leadId?: string
): Promise<string> {
  try {
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    
    // Extract key terms from the query for text search
    const searchTerms = queryText
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(term => term.length > 3)
      .slice(0, 10)
      .join(' | '); // OR search
    
    console.log(`[ai_task] Text search terms: "${searchTerms.slice(0, 100)}..."`);
    
    // Build query for text-based search
    let query = supabaseAdmin
      .from("kb_chunks")
      .select("id, title, content, source")
      .eq("owner_user_id", userId)
      .eq("allowed_customer_facing", true)
      .eq("processing_status", "completed")
      .limit(5);
    
    // Filter by lead_id if provided (include both lead-specific and global knowledge)
    if (leadId) {
      query = query.or(`lead_id.eq.${leadId},lead_id.is.null`);
    }
    
    // Use ilike for flexible text matching on multiple terms
    // Search in content for any of the key terms
    const keyTerms = queryText
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(term => term.length > 4)
      .slice(0, 5);
    
    if (keyTerms.length > 0) {
      // Create an OR condition for content matching
      const contentFilters = keyTerms.map(term => `content.ilike.%${term}%`).join(',');
      query = query.or(contentFilters);
    }
    
    const { data: matches, error } = await query;

    if (error) {
      console.error("[ai_task] Text search failed:", error);
      return "";
    }

    if (!matches || matches.length === 0) {
      console.log("[ai_task] No text matches found");
      return "";
    }

    console.log(`[ai_task] Found ${matches.length} text matches${leadId ? ` for lead ${leadId}` : ""}`);

    // Format the matched chunks as context
    const context = matches
      .map((m: { title: string | null; content: string; source: string | null }) => {
        const header = m.title ? `[${m.title}]` : "";
        return `${header}\n${m.content}`;
      })
      .join("\n\n---\n\n");

    return context;
  } catch (err) {
    console.error("[ai_task] Error in text search:", err);
    return "";
  }
}

// Dynamic CORS based on allowed origins
function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigins = Deno.env.get("ALLOWED_ORIGINS")?.split(",") || [];
  
  // In development, allow localhost origins; in production, allow Lovable project domains
  const isLocalhost = origin.includes("localhost") || origin.includes("127.0.0.1");
  const isLovableProject = origin.endsWith(".lovableproject.com");
  const isLovableApp = origin.endsWith(".lovable.app");
  const isAllowed = allowedOrigins.includes(origin) || isLocalhost || isLovableProject || isLovableApp || allowedOrigins.includes("*");
  
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// System prompt
const SYSTEM_GLOBAL_PROMPT = `You are Lead Rocket AI, an AI-powered sales execution assistant.

Primary Goal:
Generate high-quality sales messages that maximize reply probability while maintaining professionalism and alignment with the selected industry playbook.

HARD RULES
1) Nothing is ever auto-sent. You only create drafts and suggested actions.
2) Never invent facts. If unknown, ask for missing info or propose a safe next step.
3) No medical advice. No diagnosis/treatment claims. Do not claim clinical performance unless explicitly present in Knowledge Context.
4) No legal advice. For privacy/security questions, provide general best practices and point to official/security documentation if provided.
5) Customer-safe: do not share internal-only pricing/roadmap/confidential notes unless Knowledge Context explicitly marks it as allowed_customer_facing=true.
6) Be concise and structured: short paragraphs, 1 clear CTA per email, avoid jargon and marketing hype.
7) Personalize using lead/company/context. If missing, keep it generic and ask 1 clarifying question only when necessary.
8) If a task requires JSON, output JSON ONLY (no extra text). If output is an email body, output only the body text (no subject unless asked).
9) If you include "evidence", keep evidence snippets <= 200 characters.
10) Never fabricate claims. Respect compliance and disallowed topics.
11) Optimize for clarity and momentum.

OBJECTION HANDLING
When an objection is detected in the conversation:
1) Acknowledge briefly — show you understand their concern.
2) Provide focused reframing or relevant documentation (max 3-5 sentences).
3) Offer one low-friction next step.
Do not argue. Do not over-explain. Do not sound defensive.

INPUTS YOU MAY RECEIVE
- Lead context (name, company, motion, notes, meeting link)
- Interaction snippets (emails, meeting summaries)
- Optional Knowledge Context (approved snippets, product decks, FAQs)
- Playbook Context (industry-specific tone, objections, signals)
- Motion blocks (outbound, inbound, nurture, closing, post-meeting)

YOUR GOAL
Maximize reply probability, surface risks early, and guide next steps while staying compliant and professional.`;

// Cold outreach style blocks — injected for outbound first-touch emails
const COLD_OUTREACH_STYLE_BLOCK = `
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

// Psychological reply patterns — rotated into follow-up and breakup emails
const REPLY_PATTERNS_BLOCK = `
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
const BREAKUP_CLOSERS: Record<string, string> = {
  b2b_saas: `Breakup style: "I haven't heard back, so I'll assume this isn't a priority right now. If I'm wrong, happy to reconnect. Either way — appreciate the time."`,
  general_sales: `Breakup style: "Seems like timing may not be right. Should I close the loop for now?"`,
};

// Map playbook IDs to specialized outreach blocks
const PLAYBOOK_OUTREACH_BLOCKS: Record<string, string> = {
  b2b_saas: COLD_OUTREACH_SAAS_BLOCK,
  medical_device_rep: COLD_OUTREACH_MEDICAL_BLOCK,
};

function getColdOutreachBlock(playbookId: string): string {
  return PLAYBOOK_OUTREACH_BLOCKS[playbookId] || COLD_OUTREACH_STYLE_BLOCK;
}

// Centralized motion block builder
function buildMotionBlock({ motion, first_touch }: { motion: string; first_touch: boolean }): string {
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
- Acknowledge context directly.
- Provide one helpful detail.
- Offer a clear next step.

Length:
- Up to 150 words allowed.`;
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

// Centralized style modifier builder
function buildStyleModifier({ motion, first_touch, outbound_style }: { motion: string; first_touch: boolean; outbound_style: string }): string {
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

// Single-pass prompt assembler — enforces strict block order
function buildFinalUserPrompt({ motionBlock, styleModifier, playbookContext, taskPrompt }: {
  motionBlock: string;
  styleModifier: string;
  playbookContext: string;
  taskPrompt: string;
}): string {
  const parts: string[] = [];
  if (motionBlock) parts.push(motionBlock);
  if (styleModifier) parts.push(styleModifier);
  if (playbookContext) parts.push(playbookContext);
  parts.push(taskPrompt);
  return parts.join("\n\n");
}

// Task prompts
const PROMPTS: Record<string, string> = {
  intent_router: `You are classifying an inbound B2B email for a regulated enterprise sales process.

Return JSON ONLY in this exact schema:
{
  "intent_primary": "book_meeting|pricing|technical_sdk|security_privacy|legal_procurement|partnership|support|not_sure",
  "urgency": "high|medium|low",
  "reply_worthy": true,
  "suggested_motion": "outbound_prospecting|inbound_response|nurture|closing|post_meeting",
  "questions_extracted": ["..."],
  "tone": "positive|neutral|negative"
}

Rules:
- reply_worthy=true if the email requires a response from sales (questions, requests, objections, meeting scheduling).
- suggested_motion=inbound_response if urgency high OR explicit request for call/demo/pricing/procurement steps.
- Extract explicit questions verbatim into questions_extracted.
- If unclear, intent_primary="not_sure" and reply_worthy=true.

INPUT:
Lead Context:
{{LEAD_CONTEXT}}

Inbound Email:
{{EMAIL_TEXT}}`,

  email_intro_fast: `ROLE
You are writing an intro email reply for a high-urgency regulated B2B lead.

GOAL
Respond clearly, create confidence, and book a meeting soon.

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Inbound Email:
{{EMAIL_TEXT}}

Knowledge Context (approved snippets):
{{KNOWLEDGE_CONTEXT}}

Meeting Link:
{{MEETING_LINK}}

Custom Instructions:
{{CUSTOM_INSTRUCTIONS}}

CONSTRAINTS
- 120–180 words
- 1 clear CTA (book a 30-min call)
- If they asked questions, answer briefly and offer to cover deeper on call
- Do NOT mention anything not in Knowledge Context
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context
- SIGN-OFF: End with "Best," followed by the rep's first name extracted from the "Sender Name" field in Rep Context above
- CRITICAL: Use the ACTUAL names from the contexts above. NEVER output bracketed placeholders like [Name], [Unknown Company], [Rep's first name], [Your Name], [Lead's implied need], [Meeting Link], etc.
- If the lead's company is missing or says "Unknown Company", simply omit company references rather than using placeholders
- MEETING LINK: CRITICAL - You MUST use the EXACT URL provided in "Meeting Link" above. Copy it verbatim. Do NOT invent, modify, or guess any meeting/calendar URLs. If Meeting Link is empty, ask them to reply with their availability instead. Do NOT mention timezones.

OUTPUT
Return EMAIL BODY ONLY. The email must be complete and ready to send with real names.`,

  email_intro_nurture: `ROLE
You are writing a value-led intro email reply for a regulated B2B lead.

GOAL
Be helpful, provide 1–2 value points, share 1 resource, invite a call without pressure.

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Inbound Email:
{{EMAIL_TEXT}}

Knowledge Context (approved snippets):
{{KNOWLEDGE_CONTEXT}}

Optional resource to mention:
{{RESOURCE_LINK_OR_TITLE}}

Meeting Link:
{{MEETING_LINK}}

Custom Instructions:
{{CUSTOM_INSTRUCTIONS}}

CONSTRAINTS
- 140–220 words
- Helpful tone, credibility-building
- 1 soft CTA (offer a call / ask what's best next step)
- Use Knowledge Context only
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context
- SIGN-OFF: End with "Best," followed by the rep's first name extracted from the "Sender Name" field in Rep Context above
- CRITICAL: Use the ACTUAL names from the contexts above. NEVER output bracketed placeholders like [Name], [Unknown Company], [Rep's first name], [Your Name], [Lead's implied need], [Meeting Link], etc.
- If the lead's company is missing or says "Unknown Company", simply omit company references rather than using placeholders
- MEETING LINK: CRITICAL - You MUST use the EXACT URL provided in "Meeting Link" above. Copy it verbatim. Do NOT invent, modify, or guess any meeting/calendar URLs. If Meeting Link is empty, ask them to reply with their availability instead. Do NOT mention timezones.

OUTPUT
Return EMAIL BODY ONLY. The email must be complete and ready to send with real names.`,

  followup_sequence_4: `Generate a 4-email follow-up sequence for a regulated B2B prospect.
Use the motion context to determine tone and pacing.

IMPORTANT: Use the configured cadence timing provided below. This defines the days between each email in the sequence.
Configured cadence: {{CADENCE_DAYS}}

Return JSON ONLY in this schema:
{
  "motion": "{{MODE}}",
  "cadence_days": {{CADENCE_DAYS}},
  "emails": [
    {"draft_type":"fu1","subject":"...","body":"..."},
    {"draft_type":"fu2","subject":"...","body":"..."},
    {"draft_type":"fu3","subject":"...","body":"..."},
    {"draft_type":"fu4","subject":"...","body":"..."}
  ]
}

Rules:
- Each email must have ONE CTA
- Keep bodies short: 80–150 words
- Email 2 adds value (insight/resource)
- Email 3 adds urgency (light, not pushy)
- Email 4 is a polite breakup
- Never include medical claims or unapproved info
- If mentioning "I'll follow up in X days", use the appropriate value from the configured cadence

INPUT:
Mode: {{MODE}}
Lead Context: {{LEAD_CONTEXT}}
What has been sent so far (optional): {{SENT_SO_FAR}}
Knowledge Context: {{KNOWLEDGE_CONTEXT}}
Meeting link (optional): {{MEETING_LINK}}`,

  post_meeting_recap: `You are given a meeting summary (or notes). Produce:
1) an internal recap
2) a customer follow-up email draft

Return JSON ONLY:
{
  "internal_recap_bullets": ["..."],
  "milestones_from_meeting": [{"description":"...","status":"completed|pending","date":null}],
  "open_questions": ["..."],
  "customer_email": {"subject":"...","body":"..."}
}

Rules:
- Internal recap can be direct
- Customer email must be polished, positive, accurate
- Include clear next steps (who does what)
- One CTA (e.g. confirm next meeting / share doc)
- Use Knowledge Context if it helps answer questions raised

INPUT:
Mode: {{MODE}}
Lead Context: {{LEAD_CONTEXT}}
Meeting Summary: {{MEETING_SUMMARY}}
Knowledge Context: {{KNOWLEDGE_CONTEXT}}
Meeting link (optional): {{MEETING_LINK}}`,

  answer_questions: `ROLE
You are rewriting a sales email draft to answer prospect questions using knowledge base information.

GOAL
Write a complete, ready-to-send email that answers the prospect's question(s), grounded ONLY in the Knowledge Context.
If knowledge is insufficient, say what you can, then propose a call or offer to share the right document.

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Current Draft:
{{DRAFT_TEXT}}

Questions to Answer:
{{QUESTIONS_LIST}}

Knowledge Context (approved snippets):
{{KNOWLEDGE_CONTEXT}}

Meeting link (optional):
{{MEETING_LINK}}

CONSTRAINTS
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context (e.g., if lead name is "Mukul Gupta", write "Hi Mukul,")
- SIGN-OFF: End with "Best regards," on one line, then the rep's FIRST NAME ONLY (extracted from Sender Name in Rep Context) on the next line with NO blank line between (e.g., if Sender Name is "Sarah Johnson", write "Best regards,\nSarah")
- CRITICAL: Use the ACTUAL names from the contexts above. NEVER output bracketed placeholders like [Name], [Rep's First Name], [Your Name], etc.
- MEETING LINK EMBEDDING: CRITICAL - If a "Calendar Link" appears in Rep Context above, you MUST embed the complete URL directly in a sentence (e.g., "You can book a time here: https://calendly.com/shai-benchmuel/30min"). Copy the exact URL. Do NOT use "[Meeting Link]" placeholder. If no Calendar Link provided, suggest they reply with availability.
- DURATION: Do NOT mention specific meeting durations like "15-minute" or "30-minute" unless you can confidently extract it from the Meeting Link URL. Use generic terms like "call" or "meeting" instead.
- The email must be complete and ready to send
- No subject line - only the email body
- No signature block - just the closing and first name

OUTPUT
Return the complete EMAIL BODY ONLY with real names (not placeholders).`,

  extract_milestones_risks: `Extract deal milestones and risks from the provided interactions and any meeting summaries in the knowledge context.
Return JSON ONLY:
{
  "milestones": [
    {"description":"...","status":"completed|pending","date":"YYYY-MM-DD|null","evidence":"short quote <=200 chars"}
  ],
  "risks": [
    {"issue":"...","level":"low|medium|high","evidence":"short quote <=200 chars"}
  ]
}

Rules:
- Only include items supported by evidence from the interactions or knowledge context
- Evidence must be a short snippet from the interactions or knowledge (<=200 chars)
- If no items, return empty arrays
- Prioritize information from meeting summaries in knowledge context

Lead Context:
{{LEAD_CONTEXT}}

Interactions (most recent first):
{{INTERACTIONS_TEXT}}

Knowledge Context (includes meeting summaries):
{{KNOWLEDGE_CONTEXT}}`,

  extract_deal_factors: `Return JSON ONLY:
{
  "engagement_level":"high|medium|low",
  "reply_latency":"fast|medium|slow|unknown",
  "decision_maker_involved": true|false|"unknown",
  "identified_champion": "none|unknown|role_or_name",
  "budget_status":"known|unknown|blocked|in_review",
  "timeline":"urgent|normal|long|unknown",
  "procurement_stage":"none|security|legal|procurement|contract_redlines|unknown",
  "overall_outlook":"positive|neutral|negative",
  "reasoning":"1-3 sentences grounded in evidence"
}

Rules:
- Use provided interactions, meeting notes, and knowledge context
- If uncertain, use unknown
- Keep reasoning short and fact-based
- Prioritize information from meeting summaries in knowledge context

Lead Context:
{{LEAD_CONTEXT}}

Interactions:
{{INTERACTIONS_TEXT}}

Knowledge Context (includes meeting summaries):
{{KNOWLEDGE_CONTEXT}}`,

  recommend_next_steps: `Return JSON ONLY:
{
  "recommendations": [
    {"title":"...", "why":"...", "action":"email|linkedin|meeting|internal", "priority":"P0|P1|P2"}
  ],
  "best_next_step": {"title":"...", "why":"...", "action":"email|linkedin|meeting|internal"}
}

Rules:
- Must be specific, actionable, tied to what's missing
- Keep "why" to 1–2 sentences
- Prefer P0 actions that unblock the next gate (security, decision maker, meeting, etc.)
- Consider meeting summaries and lead-specific knowledge context

Lead Context:
{{LEAD_CONTEXT}}

Current milestones/risks:
{{MILESTONES_RISKS_JSON}}

Deal factors:
{{DEAL_FACTORS_JSON}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}`,

  linkedin_connect: `Write a LinkedIn connection note under 300 characters.
No selling. Mention a real reason to connect (context given).
Return TEXT ONLY.

Prospect: {{PROSPECT_NAME}}, {{TITLE}} at {{COMPANY}}
Context: {{CONTEXT}}`,

  linkedin_followup: `Write a short LinkedIn message (max 600 characters).
Professional, friendly, one question at the end.
No hard pitch. Offer a relevant insight.
Return TEXT ONLY.

Prospect: {{PROSPECT_NAME}}, {{TITLE}} at {{COMPANY}}
Context: {{CONTEXT}}
Knowledge Context (optional): {{KNOWLEDGE_CONTEXT}}`,

  // Pre-Meeting Email Cadence
  pre_email_1_intro: `ROLE
You are generating Email 1 (Intro) in a pre-meeting outreach cadence for a regulated B2B deal.

GOAL
Introduce the company clearly, personalize to the lead, and encourage booking the first meeting.

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}

Meeting Link:
{{MEETING_LINK}}

Custom Instructions:
{{CUSTOM_INSTRUCTIONS}}

CONSTRAINTS
- 120–180 words
- Professional, confident, non-pushy
- No medical or performance claims
- Use only approved Knowledge Context
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context (e.g., if lead name is "Talal Khan", write "Hi Talal,")
- SIGN-OFF: End with "Best regards," on one line, then the rep's FIRST NAME ONLY (extracted from "Sender Name" in Rep Context) on the next line with NO blank line between (e.g., if Sender Name is "Shai Benchmuel", write "Best regards,\nShai")
- CRITICAL: Use the ACTUAL names and company from the contexts above. NEVER output bracketed placeholders like [Name], [Unknown Company], [Rep's first name], [Your Name], [Lead's implied need], [Meeting Link], etc.
- If the lead's company is missing or says "Unknown Company", simply omit company references rather than using placeholders
- MEETING LINK EMBEDDING: CRITICAL - If a "Calendar Link" appears in Rep Context above, you MUST embed the complete URL directly in a sentence (e.g., "You can book a time here: https://calendly.com/shai-benchmuel/30min"). Copy the exact URL. Do NOT use placeholders or truncate. If no Calendar Link, ask them to reply with availability.
- DURATION: Do NOT mention specific meeting durations like "15-minute" or "30-minute" call unless you can confidently extract it from the Meeting Link URL. Use generic terms like "call" or "meeting" instead.
- One clear CTA (book a call)

OUTPUT
Return EMAIL BODY ONLY. The email must be complete and ready to send with real names.`,

  pre_email_2_followup: `ROLE
You are generating Email 2 in a pre-meeting outreach cadence.

GOAL
Politely follow up after no response, add one value point, and reduce friction to reply.

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Previous Outreach Summary:
{{PREVIOUS_EMAIL_SUMMARY}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}

Meeting Link:
{{MEETING_LINK}}

Custom Instructions:
{{CUSTOM_INSTRUCTIONS}}

CONSTRAINTS
- 90–140 words
- Friendly, respectful of time
- Briefly reference previous email
- No hype or guarantees
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context
- SIGN-OFF: End with "Best regards," on one line, then the rep's FIRST NAME ONLY (extracted from Sender Name in Rep Context) on the next line with NO blank line between
- CRITICAL: Use the ACTUAL names from the contexts above. NEVER output bracketed placeholders like [Name], [Unknown Company], [Rep's first name], [Your Name], [Meeting Link], etc.
- If the lead's company is missing or says "Unknown Company", simply omit company references rather than using placeholders
- MEETING LINK EMBEDDING: CRITICAL - If a "Calendar Link" appears in Rep Context above, you MUST embed the complete URL directly in a sentence (e.g., "Book here: https://calendly.com/..."). Copy exact URL. If no Calendar Link, ask them to reply with availability.
- DURATION: Do NOT mention specific meeting durations unless you can extract it from the Meeting Link URL. Use generic terms like "call" or "meeting".
- One clear CTA (book a call)

OUTPUT
Return EMAIL BODY ONLY. The email must be complete and ready to send with real names.`,

  pre_email_3_followup: `ROLE
You are generating Email 3 in a pre-meeting outreach cadence.

GOAL
Check relevance, prompt a yes/no response, and keep tone professional.

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Previous Outreach Summary:
{{PREVIOUS_EMAIL_SUMMARY}}

Meeting Link:
{{MEETING_LINK}}

Custom Instructions:
{{CUSTOM_INSTRUCTIONS}}

CONSTRAINTS
- 70–120 words
- More direct, still polite
- Explicitly acknowledge silence without pressure
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context
- SIGN-OFF: End with "Best regards," on one line, then the rep's FIRST NAME ONLY (extracted from Sender Name in Rep Context) on the next line with NO blank line between
- CRITICAL: Use the ACTUAL names from the contexts above. NEVER output bracketed placeholders like [Name], [Unknown Company], [Rep's first name], [Your Name], [Meeting Link], etc.
- MEETING LINK EMBEDDING: CRITICAL - If a "Calendar Link" appears in Rep Context above, you MUST embed the complete URL directly in a sentence. Copy exact URL.
- DURATION: Do NOT mention specific meeting durations unless you can extract it from the Meeting Link URL. Use generic terms.
- One clear CTA (call, redirect, or deprioritize)

OUTPUT
Return EMAIL BODY ONLY. The email must be complete and ready to send with real names.`,

  pre_email_4_breakup: `ROLE
You are generating Email 4 (Breakup) in a pre-meeting outreach cadence.

GOAL
Close the loop respectfully and leave the door open.

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Custom Instructions:
{{CUSTOM_INSTRUCTIONS}}

CONSTRAINTS
- 50–90 words
- Calm, polite, non-defensive
- No CTA except soft invitation to reconnect
- No claims
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context (e.g., if lead name is "Talal Khan", write "Hi Talal,")
- SIGN-OFF: End with "Best regards," on one line, then the rep's FIRST NAME ONLY from Rep Context on the next line with NO blank line between (e.g., if Sender Name is "Shai Benchmuel", write "Best regards,\nShai")
- CRITICAL: Use the ACTUAL names from the contexts above. NEVER output bracketed placeholders like [Name], [Unknown Company], [Rep's first name], [Your Name], etc.

OUTPUT
Return EMAIL BODY ONLY. The email must be complete and ready to send with real names.`,

  // Post-Meeting Personalized Follow-up
  post_meeting_followup_personalized: `ROLE
Generate a single personalized post-meeting follow-up email.

GOAL
Move the deal forward based on a specific objective.

CONSTRAINTS
- 100–200 words
- One clear CTA based on the goal
- Use Knowledge Context to answer questions or provide resources
- No medical or performance claims
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context
- SIGN-OFF: End with "Best regards," on one line, then the rep's FIRST NAME ONLY on the next line with NO blank line between
- MEETING LINK EMBEDDING: CRITICAL - If a "Calendar Link" appears in Rep Context, embed the complete URL directly in a sentence
- DURATION: Do NOT mention specific meeting durations unless you can extract it from the Meeting Link URL

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Goal:
{{GOAL}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}

Meeting Link:
{{MEETING_LINK}}

OUTPUT
Return EMAIL BODY ONLY.`,

  // Nurture Sequence
  nurture_sequence: `ROLE
Generate a nurture email sequence.

GOAL
Maintain engagement over time with value-driven messaging.

CONSTRAINTS
- 3–6 emails depending on theme complexity
- Educational, credibility-building
- No pressure, no hard sell
- Each email 100–180 words
- Each email has ONE value point and ONE soft CTA

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Cadence:
{{CADENCE}}

Theme:
{{THEME}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}

OUTPUT
Return JSON ONLY:
{
  "theme": "technical|use_case|roi|compliance",
  "cadence": "weekly|biweekly|monthly",
  "emails": [
    {"email_number": 1, "subject": "...", "body": "..."},
    {"email_number": 2, "subject": "...", "body": "..."}
  ]
}`,

  // Utility: Shorten Draft (multi-purpose one-click action)
  shorten_draft: `ROLE
You are a professional email editor performing a specific edit action on a sales email draft.

ACTION TO PERFORM: {{TARGET}}

Available actions:
- fix_grammar: Fix grammar, spelling, and improve clarity without changing meaning
- shorten_30: Shorten by ~30-40% while keeping key points and CTA
- add_meeting_cta: Update final paragraph with a stronger meeting CTA
- rewrite_tone: Rewrite the email with tone "{{TONE}}" (Friendly, Very Professional, Warm, or Concise)

INPUTS
Draft Text:
{{DRAFT_TEXT}}

Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

CONSTRAINTS
- Output a COMPLETE, ready-to-send email
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context (e.g., if lead name is "John Smith", write "Hi John,")
- SIGN-OFF: End with "Best regards," on one line, then the rep's FIRST NAME ONLY from Rep Context on the next line with NO blank line between (e.g., if Sender Name is "Sarah Johnson", write "Best regards,\nSarah")
- CRITICAL: Use the ACTUAL names from the contexts above. NEVER output bracketed placeholders like [Name], [Rep's First Name], [Your Name], etc.
- Maintain the core message and CTA
- Keep professional tone (unless rewrite_tone specifies otherwise)
- Do NOT add any new claims or facts
- Do NOT include pricing, discounts, or commercial terms
- Preserve all grounded information from the original
- If add_meeting_cta: CRITICAL - embed the complete Calendar Link URL from Rep Context directly in a sentence if provided (e.g., "Book here: https://calendly.com/..."). Do NOT use placeholders or truncate.
- If rewrite_tone: adjust the overall tone to match "{{TONE}}" while preserving facts and intent
- No signature block - just the closing and first name

OUTPUT
Return the complete revised email body with real names (not placeholders). No JSON. No markdown.`,

  // Single Nurture Email (progressive generation)
  nurture_email_single: `ROLE
Generate the next email in a nurture sequence.

GOAL
Create one value-driven follow-up email that builds on previous emails in the sequence.

CONSTRAINTS
- 100–180 words
- Educational, credibility-building
- No pressure, no hard sell
- ONE value point and ONE soft CTA
- Must feel connected to the previous emails (not repetitive)
- Do NOT repeat talking points from previous emails
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context
- SIGN-OFF: End with "Best regards," on one line, then the rep's FIRST NAME ONLY on the next line with NO blank line between

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Theme: {{THEME}} (technical|use_case|roi|compliance)

Email Number: {{EMAIL_NUMBER}} (1, 2, or 3)

Previous Emails in Sequence:
{{PREVIOUS_EMAILS}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}

OUTPUT
Return ONLY the email body text. No JSON. No markdown. No subject line.`,

  // New: Plain-text post-meeting follow-up email (no JSON)
  post_meeting_followup_email: `ROLE
Generate a personalized follow-up email based on the meeting and FULL email thread context.

GOAL
If this is the FIRST follow-up after a meeting: Thank them, summarize key points, propose next steps.
If a follow-up was ALREADY sent (check PREVIOUS_EMAILS and LAST_OUTBOUND): Write a brief check-in referencing what was previously shared.

CRITICAL CONTEXT CHECK:
Review PREVIOUS_EMAILS and LAST_OUTBOUND before writing. If you already sent a follow-up email with:
- Materials, resources, or demo access shared
- A summary of the meeting
- Next steps already proposed
Then DO NOT:
- Say "It was great speaking with you" or "It was great talking to you today"
- Re-introduce yourself or re-summarize the meeting
- Repeat information from your last email

Instead, write a SHORT follow-up (50-100 words) asking:
- If they had a chance to review the materials
- If they have questions about what was shared
- A gentle nudge toward the next step

CONSTRAINTS
- If LAST_OUTBOUND contains materials/resources/demo access: 50-100 words check-in
- If no prior follow-up or LAST_OUTBOUND is empty: 120-200 words recap
- Professional and warm
- Reference specific topics discussed if meeting context is available
- ONE clear CTA
- No medical or performance claims
- GREETING: Start with "Hi" followed by the prospect's first name from Lead Context
- SIGN-OFF: End with "Best regards," on one line, then the rep's FIRST NAME ONLY on the next line with NO blank line between
- MEETING LINK EMBEDDING: If a "Calendar Link" appears in Rep Context, embed the complete URL directly
- Return EMAIL BODY ONLY (no subject line, no JSON, no markdown)

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Meeting Summary (optional brief notes):
{{MEETING_SUMMARY_BRIEF}}

Previous Emails (most recent first):
{{PREVIOUS_EMAILS}}

Your Last Email Sent:
{{LAST_OUTBOUND}}

Knowledge Context (relevant to this lead):
{{KNOWLEDGE_CONTEXT}}

Meeting Link:
{{MEETING_LINK}}

OUTPUT
Return ONLY the email body text.`,
  // Match sent email to pending milestones
  match_email_to_milestones: `Analyze a sent email and determine which pending milestones it addresses.

TASK
Match the email content to pending milestones that it fulfills or completes.

INPUTS
Email Subject: {{EMAIL_SUBJECT}}
Email Body: {{EMAIL_BODY}}

Pending Milestones:
{{PENDING_MILESTONES}}

OUTPUT
Return JSON ONLY:
{
  "completed_indices": [0, 2],
  "reasoning": "Email addresses milestone #0 by sending the security documentation, and milestone #2 by sharing pricing."
}

RULES
- "completed_indices" is an array of milestone indices (0-based) that the email addresses
- Only include milestones where the email CLEARLY addresses or fulfills them
- Look for: attached documents mentioned, answers to questions, pricing info, proposals, scheduling confirmations
- If unsure, do NOT include the milestone (be conservative)
- If no milestones are addressed, return {"completed_indices": [], "reasoning": "Email does not address any pending milestones"}
- Keep reasoning to 1-2 sentences`,

  // Deduplicate milestones semantically
  dedupe_milestones: `Analyze existing milestones and identify semantic duplicates.

TASK
Given a list of milestones, identify groups that describe the same event/action.

INPUTS
Milestones:
{{MILESTONES_JSON}}

OUTPUT
Return JSON ONLY:
{
  "unique_milestones": [
    {
      "description": "Best description for this milestone",
      "status": "completed|pending",
      "date": "YYYY-MM-DD or null",
      "evidence": "...",
      "completedAt": "ISO timestamp or null",
      "merged_from": ["original desc 1", "original desc 2"]
    }
  ],
  "duplicates_removed": 3
}

RULES
- Group semantically similar milestones (e.g., "Initial meeting scheduled" and "First discovery call" are the same milestone)
- Keep the BEST description (most specific/clear)
- If ANY milestone in a group is "completed", the merged result is "completed"
- Keep the earliest date if multiple dates exist
- Keep completedAt from any completed milestone
- Merge evidence from all duplicates
- "merged_from" lists ALL original descriptions that were merged
- Single milestones with no duplicates should still appear in unique_milestones
- Be aggressive about deduplication - if milestones describe the same event, merge them`,

  // Reply to email thread
  reply_to_thread: `ROLE
You are generating a reply to an ongoing email thread in a regulated B2B sales context.

GOAL
Write a relevant, professional reply that directly addresses the latest inbound email while considering the full thread context.

CONSTRAINTS
- 80–180 words
- Directly address questions or points from the latest inbound email
- Reference previous thread context naturally if relevant
- One clear CTA (next step, meeting, or answer)
- Use Knowledge Context to provide accurate information
- No medical or performance claims
- Keep tone professional but warm
- Sign off with the Rep's first name (extract from Rep Context below) - NEVER use placeholders like [Your Name]
- Return EMAIL BODY ONLY (no subject line, no greetings like "Dear X,", start with content)

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Rep Context:
{{REP_CONTEXT}}

Email Thread (most recent first):
{{EMAIL_THREAD}}

Latest Inbound Email:
{{LATEST_INBOUND}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}

Meeting Link (optional):
{{MEETING_LINK}}

Custom Instructions:
{{CUSTOM_INSTRUCTIONS}}

OUTPUT
Return EMAIL BODY ONLY.`,

  // Analyze outgoing email to update lead stage/next action
  analyze_outgoing_email: `ROLE
You are analyzing an outgoing sales email to determine its impact on deal progression.

GOAL
Based on the email content and lead context, suggest updates to the lead's status, stage, and next action.

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Current Stage: {{CURRENT_STAGE}}
Current Next Action: {{CURRENT_NEXT_ACTION}}

Sent Email Subject: {{SENT_EMAIL_SUBJECT}}
Sent Email Body: {{SENT_EMAIL_BODY}}

ANALYSIS
Determine:
1. Should the stage change? (e.g., new → contacted, contacted → engaged if multi-touch)
2. What's the appropriate next action for follow-up?
3. Does the lead still need immediate action or is it waiting for a response?

RULES
- If this is a first outreach email, stage should be "contacted"
- If this is a follow-up email after engagement, stage stays "engaged" or higher
- After sending, typically needs_action should be FALSE (waiting for reply)
- Next action should be a logical follow-up (e.g., "send_pre_2", "wait_reply", "schedule_meeting")
- Keep reasoning factual and brief

OUTPUT FORMAT
Return JSON only:
{
  "suggested_stage": "new|contacted|engaged|post_meeting|closing|closed_won|closed_lost",
  "next_action_key": "wait_reply|send_pre_2|send_pre_3|send_pre_4|schedule_meeting|send_followup|null",
  "next_action_label": "Human readable next action label or null",
  "needs_action": false,
  "reasoning": "Brief explanation of the analysis (1-2 sentences)"
}`,

  // WhatsApp short-form message
  whatsapp_message: `ROLE
You are writing a short WhatsApp message for a B2B sales context.

GOAL
Send a quick, natural, conversational message. This is NOT an email — it's a text message.

FORMAT RULES (MANDATORY)
- Maximum 60 words
- NO greeting like "Dear" or "Hello" — start with "Hey [first name]," or "Hi [first name],"
- NO sign-off like "Best regards", "Thanks", "Warm regards" — just end naturally
- NO signature block, NO "[Rep's first name]", NO placeholders
- 2-3 short sentences maximum
- Casual, direct, friendly tone
- One emoji max, only if natural
- One soft CTA (question or suggestion)
- NO subject line

INPUTS
Lead Context:
{{LEAD_CONTEXT}}

Custom Instructions:
{{CUSTOM_INSTRUCTIONS}}

Knowledge Context:
{{KNOWLEDGE_CONTEXT}}

OUTPUT
Return the WhatsApp message text ONLY. No JSON. No markdown.`,
};

// Tasks that require the pro model
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

function replaceTemplateVars(template: string, payload: Record<string, unknown>): string {
  let result = template;
  for (const [key, value] of Object.entries(payload)) {
    const placeholder = `{{${key.toUpperCase()}}}`;
    const replacement = typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
    result = result.split(placeholder).join(replacement);
  }
  // Remove any remaining placeholders
  result = result.replace(/\{\{[A-Z_]+\}\}/g, "");
  return result;
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify JWT authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, error: "Missing authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    // Check if this is a service-role call (from automation-executor)
    const token = authHeader.replace("Bearer ", "");
    const isServiceRole = token === supabaseServiceKey;
    
    let user: { id: string } | null = null;
    
    if (isServiceRole) {
      // Service role calls are trusted (from internal edge functions)
      // Use a system user ID placeholder
      user = { id: "service-role" };
    } else {
      const supabase = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user: authUser }, error: authError } = await supabase.auth.getUser();
      if (authError || !authUser) {
        return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      user = authUser;
    }

    const { task, payload } = await req.json();

    if (!task || typeof task !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "Missing or invalid task" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const taskPrompt = PROMPTS[task];
    if (!taskPrompt) {
      return new Response(JSON.stringify({ ok: false, error: `Unknown task: ${task}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      console.error("LOVABLE_API_KEY is not configured");
      return new Response(JSON.stringify({ ok: false, error: "AI gateway not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Default cadence settings (single source of truth)
    const DEFAULT_CADENCE_SETTINGS = {
      version: 1,
      modes: {
        fast: {
          reply_pending_hours: 4,
          outbound_followups_days: [2, 3, 3, 4],
          breakup_trigger: { days_since_first_outbound: 10, days_since_last_outbound: 5 },
          post_meeting: { recap_suggest_after_hours: 4, checkins_days: [3, 7] },
        },
        nurture: {
          reply_pending_hours: 24,
          outbound_followups_days: [5, 7, 7, 10],
          breakup_trigger: { days_since_first_outbound: 30, days_since_last_outbound: 14 },
          post_meeting: { recap_suggest_after_hours: 24, checkins_days: [7, 14, 30] },
        },
      },
      flows: {
        nurture_campaigns: {
          enabled: true,
          cadences_days: { weekly: 7, biweekly: 14, monthly: 30 },
          min_days_after_last_touch: 7,
        },
      },
    };

    // Enhance payload with semantic knowledge search for relevant tasks
    let enhancedPayload = { ...payload };
    let knowledgeContextUsed = false;

    // Load cadence settings from workspace if available
    let cadenceSettings = DEFAULT_CADENCE_SETTINGS;
    if (payload?.lead_id) {
      try {
        const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const adminClient = createClient(supabaseUrl, supabaseServiceKey);
        
        // Get lead's owner to find workspace settings
        const { data: leadData } = await adminClient
          .from("leads")
          .select("owner_user_id")
          .eq("id", payload.lead_id)
          .single();
        
        if (leadData?.owner_user_id) {
          const { data: workspaceData } = await adminClient
            .from("workspace_profiles")
            .select("cadence_settings")
            .eq("user_id", leadData.owner_user_id)
            .maybeSingle();
          
          if (workspaceData?.cadence_settings) {
            // Deep merge with defaults
            cadenceSettings = {
              ...DEFAULT_CADENCE_SETTINGS,
              ...workspaceData.cadence_settings,
              modes: {
                fast: { ...DEFAULT_CADENCE_SETTINGS.modes.fast, ...(workspaceData.cadence_settings as any)?.modes?.fast },
                nurture: { ...DEFAULT_CADENCE_SETTINGS.modes.nurture, ...(workspaceData.cadence_settings as any)?.modes?.nurture },
              },
            };
            console.log(`[ai_task] Loaded workspace cadence settings for user ${leadData.owner_user_id}`);
          }
        }
      } catch (err) {
        console.error("[ai_task] Failed to load cadence settings, using defaults:", err);
      }
    }

    // Inject cadence_days for followup_sequence_4 task
    if (task === "followup_sequence_4") {
      const mode = (payload?.mode || "fast") as "fast" | "nurture";
      const cadenceDays = cadenceSettings.modes[mode]?.outbound_followups_days || [2, 3, 3, 4];
      enhancedPayload.cadence_days = JSON.stringify(cadenceDays);
      console.log(`[ai_task] Injected cadence_days for ${mode} mode: ${JSON.stringify(cadenceDays)}`);
    }
    
    // Read motion flags early (needed for KB gating)
    const motion = String(enhancedPayload.motion || "");
    const isFirstTouch = enhancedPayload.first_touch === true;
    const isOutboundFirstTouch = motion === "outbound_prospecting" && isFirstTouch;

    if (KNOWLEDGE_SEARCH_TASKS.includes(task)) {
      // Gate KB injection for outbound first touch — cold outreach must NOT be driven by long knowledge dumps
      if (isOutboundFirstTouch) {
        console.log(`[ai_task] ⚡ Outbound first touch — skipping full KB search, limiting to 1 chunk (600 char cap)`);
      }

      // Build a query from the available context
      const queryParts: string[] = [];
      if (payload?.email_text) queryParts.push(String(payload.email_text));
      if (payload?.questions_list) queryParts.push(String(payload.questions_list));
      if (payload?.lead_context) queryParts.push(String(payload.lead_context).slice(0, 500));
      if (payload?.meeting_summary) queryParts.push(String(payload.meeting_summary).slice(0, 500));
      
      const searchQuery = queryParts.join("\n").slice(0, 2000);
      
      if (searchQuery.length > 50) {
        const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const leadId = payload?.lead_id ? String(payload.lead_id) : undefined;
        console.log(`[ai_task] Searching knowledge base. Query length: ${searchQuery.length}, lead_id: ${leadId || 'global'}`);
        
        const textContext = await getTextBasedKnowledgeContext(
          searchQuery,
          supabaseUrl,
          supabaseServiceKey,
          user.id,
          leadId
        );
        
        if (textContext) {
          // For outbound first touch: cap KB context to 600 chars max
          if (isOutboundFirstTouch) {
            const capped = textContext.slice(0, 600);
            enhancedPayload.knowledge_context = capped;
            knowledgeContextUsed = true;
            console.log(`[ai_task] ✅ KB context capped for first touch: ${capped.length}/${textContext.length} chars`);
          } else {
            enhancedPayload.knowledge_context = textContext;
            knowledgeContextUsed = true;
            console.log(`[ai_task] ✅ Added text-based knowledge context (${textContext.length} chars)${leadId ? ` for lead ${leadId}` : ""}`);
          }
        } else {
          console.log(`[ai_task] ⚠️ No text matches found for task ${task}`);
        }
      } else {
        console.log(`[ai_task] Skipping knowledge search - query too short (${searchQuery.length} chars)`);
      }
    }

    // Remaining explicit flags (motion/isFirstTouch already read above)
    const playbookId = String(enhancedPayload.playbook_id || "general");
    const hasInbound = enhancedPayload.has_latest_inbound === true;

    console.log(`[ai_task] Flags — playbook: ${playbookId}, motion: ${motion}, first_touch: ${isFirstTouch}, has_inbound: ${hasInbound}`);

    // Build the task prompt with template variables replaced
    const taskBody = replaceTemplateVars(taskPrompt, enhancedPayload);

    // Compute all blocks
    const isOutboundMotion = motion === "outbound_prospecting";
    const outboundStyle = String(enhancedPayload.outbound_style || "standard");
    const isFollowUp = task === "pre_email_2_followup" || task === "pre_email_3_followup" || task === "pre_email_4_breakup";
    const isBreakup = task === "pre_email_4_breakup";

    // 1. Motion block
    const motionBlock = buildMotionBlock({ motion, first_touch: isFirstTouch });

    // 2. Style modifier (combine all style pieces into one string)
    const styleParts: string[] = [];
    const styleBlock = buildStyleModifier({ motion, first_touch: isFirstTouch, outbound_style: outboundStyle });
    if (styleBlock) styleParts.push(styleBlock);
    if (isFirstTouch && isOutboundMotion && !hasInbound) styleParts.push(getColdOutreachBlock(playbookId));
    if (isFollowUp && isOutboundMotion) styleParts.push(REPLY_PATTERNS_BLOCK);
    if (isBreakup) styleParts.push(BREAKUP_CLOSERS[playbookId] || BREAKUP_CLOSERS.general_sales);
    const styleModifier = styleParts.join("\n\n") || "";

    // 3. Playbook context
    const playbookContext = enhancedPayload.playbook_context ? String(enhancedPayload.playbook_context) : "";

    // Build final prompt in one pass
    const userPrompt = buildFinalUserPrompt({ motionBlock, styleModifier, playbookContext, taskPrompt: taskBody });

    // Log what was assembled
    if (motionBlock) console.log(`[ai_task] [1/MOTION] ${motion}${isFirstTouch ? " (first_touch)" : ""}`);
    if (styleModifier) console.log(`[ai_task] [2/STYLE] ${styleParts.length} block(s)`);
    if (playbookContext) console.log("[ai_task] [3/PLAYBOOK] Playbook context");

    // Select model based on task
    const model = PRO_MODEL_TASKS.includes(task)
      ? "google/gemini-2.5-pro"
      : "google/gemini-2.5-flash";

    console.log(`[ai_task] Task: ${task}, Model: ${model}, User: ${user.id}`);

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_GLOBAL_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ ok: false, error: "Rate limit exceeded. Please try again later." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ ok: false, error: "Payment required. Please add credits to continue." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errorText = await response.text();
      console.error(`[ai_task] AI gateway error: ${response.status}`, errorText);
      return new Response(JSON.stringify({ ok: false, error: "AI gateway error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content || "";

    // Word count logging for outbound first touch (no retry — prompt handles enforcement)
    if (isOutboundFirstTouch && content) {
      const wordCount = content.split(/\s+/).filter(Boolean).length;
      console.log(`[ai_task] Outbound first touch word count: ${wordCount}`);
    }

    console.log(`[ai_task] Success. Response length: ${content.length}, knowledge_used: ${knowledgeContextUsed}`);

    return new Response(
      JSON.stringify({ ok: true, content, raw: data, knowledge_context_used: knowledgeContextUsed }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorId = crypto.randomUUID();
    console.error(`[ai_task] Error ${errorId}:`, error);
    return new Response(
      JSON.stringify({ ok: false, error: "An error occurred while processing your request", error_id: errorId }),
      { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );
  }
});
