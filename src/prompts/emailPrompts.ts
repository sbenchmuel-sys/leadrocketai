// 03_EMAIL_PROMPTS
// Task prompts for email generation - selected based on Intent Router output

// ============================================
// INTRO EMAIL - FAST
// ============================================
export const EMAIL_INTRO_FAST_PROMPT = `Write a FAST intro email reply for a regulated B2B lead.
Goal: respond clearly, create confidence, and book a meeting soon.

Constraints:
- 120–180 words
- 1 clear CTA (book a 30-min call)
- If they asked questions, answer briefly and offer to cover deeper on call
- Do NOT mention anything not in Knowledge Context
- Return EMAIL BODY ONLY

Lead Context:
{{LEAD_CONTEXT}}

Inbound Email:
{{EMAIL_TEXT}}

Knowledge Context (approved snippets):
{{KNOWLEDGE_CONTEXT}}

Meeting link (optional):
{{MEETING_LINK}}`;

// ============================================
// INTRO EMAIL - NURTURE
// ============================================
export const EMAIL_INTRO_NURTURE_PROMPT = `Write a NURTURE intro email reply for a regulated B2B lead.
Goal: be helpful, provide 1–2 value points, share 1 resource, invite a call without pressure.

Constraints:
- 140–220 words
- Helpful tone, credibility-building
- 1 soft CTA (offer a call / ask what's best next step)
- Use Knowledge Context only
- Return EMAIL BODY ONLY

Lead Context:
{{LEAD_CONTEXT}}

Inbound Email:
{{EMAIL_TEXT}}

Knowledge Context (approved snippets):
{{KNOWLEDGE_CONTEXT}}

Optional resource to mention:
{{RESOURCE_LINK_OR_TITLE}}

Meeting link (optional):
{{MEETING_LINK}}`;

// ============================================
// FOLLOW-UP SEQUENCE (4 emails) - JSON
// ============================================
export const EMAIL_FOLLOWUP_SEQUENCE_PROMPT = `Generate a 4-email follow-up sequence for a regulated B2B prospect.
Mode is either FAST or NURTURE.

Return JSON ONLY in this schema:
{
  "mode": "fast|nurture",
  "cadence_days": [3,4,4,5],
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

INPUT:
Mode: {{MODE}}
Lead Context: {{LEAD_CONTEXT}}
What has been sent so far (optional): {{SENT_SO_FAR}}
Knowledge Context: {{KNOWLEDGE_CONTEXT}}
Meeting link (optional): {{MEETING_LINK}}`;

// ============================================
// POST-MEETING RECAP + CUSTOMER EMAIL - JSON
// ============================================
export const POST_MEETING_RECAP_PROMPT = `You are given a meeting summary (or notes). Produce:
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
Meeting link (optional): {{MEETING_LINK}}`;

// ============================================
// ANSWER PROSPECT QUESTIONS
// ============================================
export const ANSWER_QUESTION_PROMPT = `Write a customer-safe email answer to the prospect's question(s), grounded ONLY in the Knowledge Context.
If knowledge is insufficient, say what you can, then propose a call or offer to share the right document.

Return EMAIL BODY ONLY (no subject).

Lead Context:
{{LEAD_CONTEXT}}

Questions:
{{QUESTIONS_LIST}}

Knowledge Context (approved snippets):
{{KNOWLEDGE_CONTEXT}}

Meeting link (optional):
{{MEETING_LINK}}`;

// ============================================
// TypeScript Types
// ============================================

export interface FollowUpEmail {
  draft_type: 'fu1' | 'fu2' | 'fu3' | 'fu4';
  subject: string;
  body: string;
}

export interface FollowUpSequenceOutput {
  mode: 'fast' | 'nurture';
  cadence_days: [number, number, number, number];
  emails: [FollowUpEmail, FollowUpEmail, FollowUpEmail, FollowUpEmail];
}

export interface MilestoneFromMeeting {
  description: string;
  status: 'completed' | 'pending';
  date: string | null;
}

export interface CustomerEmail {
  subject: string;
  body: string;
}

export interface PostMeetingRecapOutput {
  internal_recap_bullets: string[];
  milestones_from_meeting: MilestoneFromMeeting[];
  open_questions: string[];
  customer_email: CustomerEmail;
}

// Helper to select intro email prompt based on motion
export function getIntroEmailPrompt(motion: string): string {
  // Inbound/nurture motions use the nurture-style intro; outbound uses fast
  if (motion === "nurture" || motion === "inbound_response") {
    return EMAIL_INTRO_NURTURE_PROMPT;
  }
  return EMAIL_INTRO_FAST_PROMPT;
}

// ============================================
// RE-ENGAGEMENT EMAIL
// ============================================
export const REENGAGE_EMAIL_PROMPT = `Write a re-engagement email for a lead who hasn't responded in a while.
The goal is to restart the conversation with value, not pressure.

Strategy: Provide value first, then include a soft CTA.

Suggested hooks to consider:
- Industry news or update relevant to their business
- New feature or capability that addresses their needs
- Case study from a similar company
- Quarterly/seasonal check-in
- Helpful resource or insight

Constraints:
- 100–150 words
- Lead with value, not "checking in"
- 1 soft CTA (offer to help, share something, or suggest a quick call)
- Be warm but professional, not desperate
- Do NOT mention anything not in Knowledge Context
- Return EMAIL BODY ONLY

Lead Context:
{{LEAD_CONTEXT}}

Knowledge Context (approved snippets):
{{KNOWLEDGE_CONTEXT}}

Days since last contact: {{DAYS_SINCE_CONTACT}}

Meeting link (optional):
{{MEETING_LINK}}`;

// ============================================
// NURTURE EMAIL
// ============================================
export const NURTURE_EMAIL_PROMPT = `Write a nurture email for a lead in long-term nurture mode.
The goal is to stay top of mind with value, not to push for a meeting.

Theme suggestions:
- Industry insights or trends
- Product tips or best practices
- Case study highlight
- Educational content or resource

Constraints:
- 80–120 words
- Focus on providing value
- 1 soft CTA at most (e.g., "happy to chat if this resonates")
- No pressure, no urgency
- Do NOT mention anything not in Knowledge Context
- Return EMAIL BODY ONLY

Lead Context:
{{LEAD_CONTEXT}}

Nurture cadence: {{NURTURE_CADENCE}}

Knowledge Context (approved snippets):
{{KNOWLEDGE_CONTEXT}}

Meeting link (optional):
{{MEETING_LINK}}`;

export interface ReengageEmailParams {
  leadContext: string;
  knowledgeContext: string;
  daysSinceContact: number;
  meetingLink?: string;
}

export interface NurtureEmailParams {
  leadContext: string;
  nurtureCadence: 'weekly' | 'biweekly' | 'monthly';
  knowledgeContext: string;
  meetingLink?: string;
}
