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

// Character limits for validation
export const LINKEDIN_CHAR_LIMITS = {
  connectionNote: 300,
  followUpMessage: 600,
} as const;

// Validation helper
export function validateLinkedInLength(
  text: string,
  type: 'connectionNote' | 'followUpMessage'
): { valid: boolean; length: number; limit: number } {
  const limit = LINKEDIN_CHAR_LIMITS[type];
  return {
    valid: text.length <= limit,
    length: text.length,
    limit,
  };
}
