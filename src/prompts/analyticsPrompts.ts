// 04_ANALYTICS_AND_RECOMMENDATIONS_PROMPTS
// Task prompts for deal analysis - always validate JSON outputs

// ============================================
// EXTRACT MILESTONES & RISKS - JSON
// ============================================
export const EXTRACT_MILESTONES_RISKS_PROMPT = `Extract deal milestones and risks from the provided interactions.
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
- Only include items supported by evidence from the interactions
- Evidence must be a short snippet from the interactions (<=200 chars)
- If no items, return empty arrays

Lead Context:
{{LEAD_CONTEXT}}

Interactions (most recent first):
{{INTERACTIONS_TEXT}}`;

// ============================================
// EXTRACT DEAL FACTORS - JSON
// ============================================
export const EXTRACT_DEAL_FACTORS_PROMPT = `Return JSON ONLY:
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
- Use only provided interactions + meeting notes
- If uncertain, use unknown
- Keep reasoning short and fact-based

Lead Context:
{{LEAD_CONTEXT}}

Interactions:
{{INTERACTIONS_TEXT}}`;

// ============================================
// RECOMMEND NEXT STEPS - JSON
// ============================================
export const NEXT_STEPS_RECOMMENDER_PROMPT = `Return JSON ONLY:
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

Lead Context:
{{LEAD_CONTEXT}}

Current milestones/risks:
{{MILESTONES_RISKS_JSON}}

Deal factors:
{{DEAL_FACTORS_JSON}}`;

// ============================================
// TypeScript Types
// ============================================

export interface Milestone {
  description: string;
  status: 'completed' | 'pending';
  date: string | null;
  evidence: string;
}

export interface Risk {
  issue: string;
  level: 'low' | 'medium' | 'high';
  evidence: string;
}

export interface MilestonesRisksOutput {
  milestones: Milestone[];
  risks: Risk[];
}

export type EngagementLevel = 'high' | 'medium' | 'low';
export type ReplyLatency = 'fast' | 'medium' | 'slow' | 'unknown';
export type BudgetStatus = 'known' | 'unknown' | 'blocked' | 'in_review';
export type Timeline = 'urgent' | 'normal' | 'long' | 'unknown';
export type ProcurementStage = 'none' | 'security' | 'legal' | 'procurement' | 'contract_redlines' | 'unknown';
export type Outlook = 'positive' | 'neutral' | 'negative';

export interface DealFactorsOutput {
  engagement_level: EngagementLevel;
  reply_latency: ReplyLatency;
  decision_maker_involved: boolean | 'unknown';
  identified_champion: string;
  budget_status: BudgetStatus;
  timeline: Timeline;
  procurement_stage: ProcurementStage;
  overall_outlook: Outlook;
  reasoning: string;
}

export type ActionType = 'email' | 'linkedin' | 'meeting' | 'internal';
export type Priority = 'P0' | 'P1' | 'P2';

export interface Recommendation {
  title: string;
  why: string;
  action: ActionType;
  priority: Priority;
}

export interface NextStep {
  title: string;
  why: string;
  action: ActionType;
}

export interface NextStepsOutput {
  recommendations: Recommendation[];
  best_next_step: NextStep;
}
