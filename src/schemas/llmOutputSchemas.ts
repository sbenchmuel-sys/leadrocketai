// 06_JSON_SCHEMAS
// Zod schemas for validating LLM JSON outputs
// Evidence fields are capped to 200 characters

import { z } from 'zod';

// ============================================
// INTENT ROUTER OUTPUT
// ============================================
export const IntentRouterSchema = z.object({
  intent_primary: z.enum([
    'book_meeting',
    'pricing',
    'technical_sdk',
    'security_privacy',
    'legal_procurement',
    'partnership',
    'support',
    'not_sure',
  ]),
  urgency: z.enum(['high', 'medium', 'low']),
  reply_worthy: z.boolean(),
  questions_extracted: z.array(z.string()),
  tone: z.enum(['positive', 'neutral', 'negative']),
}).strict();

export type IntentRouterOutput = z.infer<typeof IntentRouterSchema>;

// ============================================
// FOLLOW-UP SEQUENCE (4 emails)
// ============================================
export const FollowUpEmailSchema = z.object({
  draft_type: z.enum(['fu1', 'fu2', 'fu3', 'fu4']),
  subject: z.string().min(1).max(140),
  body: z.string().min(1).max(5000),
}).strict();

export const FollowUpSequenceSchema = z.object({
  mode: z.enum(['fast', 'nurture']),
  cadence_days: z.array(z.number().int().min(1).max(30)).length(4),
  emails: z.array(FollowUpEmailSchema).length(4),
}).strict();

export type FollowUpSequenceOutput = z.infer<typeof FollowUpSequenceSchema>;

// ============================================
// POST MEETING RECAP + CUSTOMER EMAIL
// ============================================
export const MilestoneFromMeetingSchema = z.object({
  description: z.string().min(1).max(160),
  status: z.enum(['completed', 'pending']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
}).strict();

export const CustomerEmailSchema = z.object({
  subject: z.string().min(1).max(140),
  body: z.string().min(1).max(5000),
}).strict();

export const PostMeetingRecapSchema = z.object({
  internal_recap_bullets: z.array(z.string().min(1).max(240)),
  milestones_from_meeting: z.array(MilestoneFromMeetingSchema),
  open_questions: z.array(z.string().min(1).max(200)),
  customer_email: CustomerEmailSchema,
}).strict();

export type PostMeetingRecapOutput = z.infer<typeof PostMeetingRecapSchema>;

// ============================================
// MILESTONES + RISKS EXTRACTION
// ============================================
export const MilestoneSchema = z.object({
  description: z.string().min(1).max(160),
  status: z.enum(['completed', 'pending']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  evidence: z.string().min(1).max(200),
}).strict();

export const RiskSchema = z.object({
  issue: z.string().min(1).max(200),
  level: z.enum(['low', 'medium', 'high']),
  evidence: z.string().min(1).max(200),
}).strict();

export const MilestonesRisksSchema = z.object({
  milestones: z.array(MilestoneSchema),
  risks: z.array(RiskSchema),
}).strict();

export type MilestonesRisksOutput = z.infer<typeof MilestonesRisksSchema>;

// ============================================
// DEAL FACTORS OUTPUT
// ============================================
export const DealFactorsSchema = z.object({
  engagement_level: z.enum(['high', 'medium', 'low']),
  reply_latency: z.enum(['fast', 'medium', 'slow', 'unknown']),
  decision_maker_involved: z.union([z.boolean(), z.literal('unknown')]),
  identified_champion: z.string().min(1).max(120),
  budget_status: z.enum(['known', 'unknown', 'blocked', 'in_review']),
  timeline: z.enum(['urgent', 'normal', 'long', 'unknown']),
  procurement_stage: z.enum(['none', 'security', 'legal', 'procurement', 'contract_redlines', 'unknown']),
  overall_outlook: z.enum(['positive', 'neutral', 'negative']),
  reasoning: z.string().min(1).max(600),
}).strict();

export type DealFactorsOutput = z.infer<typeof DealFactorsSchema>;

// ============================================
// NEXT STEP RECOMMENDATIONS
// ============================================
export const RecommendationSchema = z.object({
  title: z.string().min(1).max(120),
  why: z.string().min(1).max(400),
  action: z.enum(['email', 'linkedin', 'meeting', 'internal']),
  priority: z.enum(['P0', 'P1', 'P2']),
}).strict();

export const BestNextStepSchema = z.object({
  title: z.string().min(1).max(120),
  why: z.string().min(1).max(400),
  action: z.enum(['email', 'linkedin', 'meeting', 'internal']),
}).strict();

export const NextStepsSchema = z.object({
  recommendations: z.array(RecommendationSchema).min(1).max(10),
  best_next_step: BestNextStepSchema,
}).strict();

export type NextStepsOutput = z.infer<typeof NextStepsSchema>;

// ============================================
// NURTURE SEQUENCE
// ============================================
export const NurtureEmailSchema = z.object({
  email_number: z.number().int().min(1).max(10),
  subject: z.string().min(1).max(140),
  body: z.string().min(1).max(5000),
}).strict();

export const NurtureSequenceSchema = z.object({
  theme: z.enum(['technical', 'use_case', 'roi', 'compliance']),
  cadence: z.enum(['weekly', 'biweekly', 'monthly']),
  emails: z.array(NurtureEmailSchema).min(3).max(6),
}).strict();

export type NurtureSequenceOutput = z.infer<typeof NurtureSequenceSchema>;

// ============================================
// VALIDATION UTILITIES
// ============================================

export type SchemaType = 
  | 'intent_router'
  | 'followup_sequence'
  | 'post_meeting_recap'
  | 'milestones_risks'
  | 'deal_factors'
  | 'next_steps'
  | 'nurture_sequence';

const schemaMap = {
  intent_router: IntentRouterSchema,
  followup_sequence: FollowUpSequenceSchema,
  post_meeting_recap: PostMeetingRecapSchema,
  milestones_risks: MilestonesRisksSchema,
  deal_factors: DealFactorsSchema,
  next_steps: NextStepsSchema,
  nurture_sequence: NurtureSequenceSchema,
} as const;

export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: z.ZodError['errors'];
}

export function validateLLMOutput<T extends SchemaType>(
  schemaType: T,
  data: unknown
): ValidationResult<z.infer<typeof schemaMap[T]>> {
  const schema = schemaMap[schemaType];
  const result = schema.safeParse(data);

  if (result.success) {
    return { success: true, data: result.data };
  }

  return { success: false, errors: result.error.errors };
}

export function parseJSONSafe(jsonString: string): { success: boolean; data?: unknown; error?: string } {
  try {
    const data = JSON.parse(jsonString);
    return { success: true, data };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Invalid JSON' };
  }
}

export function validateAndParseLLMOutput<T extends SchemaType>(
  schemaType: T,
  jsonString: string
): ValidationResult<z.infer<typeof schemaMap[T]>> {
  const parseResult = parseJSONSafe(jsonString);
  
  if (!parseResult.success) {
    return { 
      success: false, 
      errors: [{ code: 'custom', message: parseResult.error || 'Invalid JSON', path: [] }] 
    };
  }

  return validateLLMOutput(schemaType, parseResult.data);
}
