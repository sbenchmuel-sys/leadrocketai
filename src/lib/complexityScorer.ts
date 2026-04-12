// Complexity Scorer + Model Selector — determines Fast vs Pro model for AI tasks
import type { AITaskType } from "@/hooks/useAITask";
import type { ResolvedContext } from "@/lib/contextResolver";

// ============================================
// TYPES
// ============================================

export type AIModel = "google/gemini-2.5-flash" | "google/gemini-2.5-pro";

export interface ComplexityResult {
  complexity_score: number;
  model_used: AIModel;
  scoring_factors: { label: string; points: number }[];
}

// ============================================
// COMPLEXITY SCORER
// ============================================

const COMPLEXITY_KEYWORDS = {
  pricing_legal: /pric|cost|contract|legal|compliance|terms|liability|indemnif|warrant/i,
  objection: /concern|objection|hesitat|pushback|competitor|alternative|not sure|budget/i,
  compliance: /gdpr|hipaa|soc2|iso\s?27|pci|regulatory|audit/i,
};

export function complexityScorer(
  ctx: ResolvedContext,
  intent: AITaskType,
  instructions?: string | null
): { score: number; factors: { label: string; points: number }[] } {
  const factors: { label: string; points: number }[] = [];
  let score = 0;

  // Intent-based scoring
  if (intent === "post_meeting_followup_email" || intent === "post_meeting_followup_personalized") {
    factors.push({ label: "Post-meeting intent", points: 20 });
    score += 20;
  }

  if (intent === "pre_email_3_followup" || intent === "pre_email_4_breakup") {
    factors.push({ label: "Closing/breakup intent", points: 20 });
    score += 20;
  }

  if (intent === "reply_to_thread") {
    factors.push({ label: "Thread reply (needs context)", points: 10 });
    score += 10;
  }

  // Context-based scoring
  if (ctx.meeting_packs.length > 0) {
    factors.push({ label: "Meeting summary exists", points: 15 });
    score += 15;
  }

  // Check for objections in risk signals or thread
  const allText = [
    ...ctx.risk_signals,
    ctx.thread_summary,
    ctx.last_inbound_email?.body_text || "",
  ].join(" ");

  if (COMPLEXITY_KEYWORDS.objection.test(allText)) {
    factors.push({ label: "Objections detected", points: 10 });
    score += 10;
  }

  if (COMPLEXITY_KEYWORDS.pricing_legal.test(allText)) {
    factors.push({ label: "Pricing/legal keywords", points: 15 });
    score += 15;
  }

  if (COMPLEXITY_KEYWORDS.compliance.test(allText)) {
    factors.push({ label: "Compliance constraints", points: 10 });
    score += 10;
  }

  // Workspace constraints
  const disallowed = ctx.workspace_profile?.disallowed_topics || [];
  if (disallowed.length > 0) {
    factors.push({ label: "Messaging constraints active", points: 10 });
    score += 10;
  }

  // Custom instructions add complexity
  if (instructions && instructions.trim().length > 0) {
    factors.push({ label: "Custom instructions", points: 5 });
    score += 5;
  }

  // Long thread = more context to handle
  if (ctx.thread_emails.length >= 5) {
    factors.push({ label: "Long email thread (5+)", points: 10 });
    score += 10;
  }

  return { score, factors };
}

// ============================================
// MODEL SELECTOR
// ============================================

const PRO_THRESHOLD = 35;

export function modelSelector(
  score: number,
  channel: "email" | "linkedin" | "whatsapp" | "sms" = "email"
): AIModel {
  // WhatsApp and LinkedIn always use Fast (short-form content)
  if (channel === "whatsapp" || channel === "linkedin") {
    return "google/gemini-2.5-flash";
  }

  // Email: use score to determine
  return score >= PRO_THRESHOLD ? "google/gemini-2.5-pro" : "google/gemini-2.5-flash";
}

// ============================================
// COMBINED: score + select in one call
// ============================================

export function scoreAndSelectModel(
  ctx: ResolvedContext,
  intent: AITaskType,
  channel: "email" | "linkedin" | "whatsapp" | "sms" = "email",
  instructions?: string | null
): ComplexityResult {
  const { score, factors } = complexityScorer(ctx, intent, instructions);
  const model = modelSelector(score, channel);

  return {
    complexity_score: score,
    model_used: model,
    scoring_factors: factors,
  };
}
