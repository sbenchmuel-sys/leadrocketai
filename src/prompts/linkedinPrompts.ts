// 05_LINKEDIN_PROMPTS
// Task prompts for LinkedIn messages - output must be short and copy/paste friendly

// ============================================
// LINKEDIN CONNECTION NOTE (<300 chars)
// ============================================
export const LINKEDIN_CONNECT_NOTE_PROMPT = `Write a LinkedIn connection note under 300 characters.
No selling. Mention a real reason to connect (context given).
Return TEXT ONLY.

Prospect: {{PROSPECT_NAME}}, {{TITLE}} at {{COMPANY}}
Context: {{CONTEXT}}`;

// ============================================
// LINKEDIN FOLLOW-UP MESSAGE (<=600 chars)
// ============================================
export const LINKEDIN_FOLLOWUP_MESSAGE_PROMPT = `Write a short LinkedIn message (max 600 characters).
Professional, friendly, one question at the end.
No hard pitch. Offer a relevant insight.
Return TEXT ONLY.

Prospect: {{PROSPECT_NAME}}, {{TITLE}} at {{COMPANY}}
Context: {{CONTEXT}}
Knowledge Context (optional): {{KNOWLEDGE_CONTEXT}}`;

// ============================================
// LINKEDIN REACTION COMMENT (<=250 chars)
// A short suggested comment the rep adapts when engaging with the lead's
// recent post. Plain language on screen: "React to their post".
// ============================================
export const LINKEDIN_REACTION_COMMENT_PROMPT = `Write a SHORT suggested comment (max 250 characters) the rep can leave on this prospect's most recent LinkedIn post.
Genuine and specific, like a real person reacting to the post — no selling, no pitch, no links.
Return TEXT ONLY.

Prospect: {{PROSPECT_NAME}}, {{TITLE}} at {{COMPANY}}
Context: {{CONTEXT}}`;

// ============================================
// TypeScript Types
// ============================================

export interface LinkedInProspect {
  name: string;
  title: string;
  company: string;
}

export interface LinkedInConnectNoteInput {
  prospect: LinkedInProspect;
  context: string;
}

export interface LinkedInFollowUpInput {
  prospect: LinkedInProspect;
  context: string;
  knowledgeContext?: string;
}

export interface LinkedInReactionInput {
  prospect: LinkedInProspect;
  context: string;
}

// Character limits for validation
export const LINKEDIN_CHAR_LIMITS = {
  connectionNote: 300,
  followUpMessage: 600,
  reactionComment: 250,
} as const;

// Validation helper
export function validateLinkedInLength(
  text: string,
  type: 'connectionNote' | 'followUpMessage' | 'reactionComment'
): { valid: boolean; length: number; limit: number } {
  const limit = LINKEDIN_CHAR_LIMITS[type];
  return {
    valid: text.length <= limit,
    length: text.length,
    limit,
  };
}
