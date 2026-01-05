// 02_INTENT_ROUTER_PROMPT
// Task prompt for inbound email triage
// Validates against: Intent Router Output schema (06_JSON_SCHEMAS)

export const INTENT_ROUTER_PROMPT = `You are classifying an inbound B2B email for a regulated enterprise sales process.

Return JSON ONLY in this exact schema:
{
  "intent_primary": "book_meeting|pricing|technical_sdk|security_privacy|legal_procurement|partnership|support|not_sure",
  "urgency": "high|medium|low",
  "reply_worthy": true,
  "suggested_strategy": "fast|nurture",
  "questions_extracted": ["..."],
  "tone": "positive|neutral|negative"
}

Rules:
- reply_worthy=true if the email requires a response from sales (questions, requests, objections, meeting scheduling).
- suggested_strategy=fast if urgency high OR explicit request for call/demo/pricing/procurement steps.
- Extract explicit questions verbatim into questions_extracted.
- If unclear, intent_primary="not_sure" and reply_worthy=true.

INPUT:
Lead Context:
{{LEAD_CONTEXT}}

Inbound Email:
{{EMAIL_TEXT}}`;

export type IntentPrimary = 
  | 'book_meeting'
  | 'pricing'
  | 'technical_sdk'
  | 'security_privacy'
  | 'legal_procurement'
  | 'partnership'
  | 'support'
  | 'not_sure';

export type Urgency = 'high' | 'medium' | 'low';
export type Strategy = 'fast' | 'nurture';
export type Tone = 'positive' | 'neutral' | 'negative';

export interface IntentRouterOutput {
  intent_primary: IntentPrimary;
  urgency: Urgency;
  reply_worthy: boolean;
  suggested_strategy: Strategy;
  questions_extracted: string[];
  tone: Tone;
}
