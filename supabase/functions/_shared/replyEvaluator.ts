// ============================================
// REPLY QUALITY EVALUATOR / POLICY CHECKER
// Validates generated reply against orchestration context
// ============================================

import type { ReplyObjective } from "./replyObjective.ts";
import type { ResolvedPolicy } from "./stagePolicy.ts";
import type { ClassifiedDecision } from "./intentClassifier.ts";

// ── Evaluation result types ──────────────────

export interface PolicyViolation {
  rule: string;
  severity: "high" | "medium" | "low";
  detail: string;
}

export interface ReplyEvaluation {
  objective_alignment_score: number;   // 0-10
  cta_alignment_score: number;         // 0-10
  focus_score: number;                 // 0-10
  commercial_relevance_score: number;  // 0-10
  policy_violations: PolicyViolation[];
  regeneration_recommended: boolean;
  evaluation_summary: string;
  dominant_layer: string; // which orchestration layer most influenced the reply
}

// ── Leaked-label patterns (must never appear in customer-facing output) ──

const LEAKED_LABEL_PATTERNS = [
  /\bstage[_\s]?policy\b/i,
  /\breply[_\s]?objective\b/i,
  /\bobjection[_\s]?class\b/i,
  /\bcommercial[_\s]?intent\b/i,
  /\binternal[_\s]?reasoning\b/i,
  /\binternal[_\s]?analysis\b/i,
  /\borganic[_\s]?escalation\b/i,
  /\bde[-_]?escalat/i,
  /\bP[012]\b(?=\s*priority|\s*action)/i,
  /\bsuppressed[_\s]?(?:cta|offer)\b/i,
  /\boffer[_\s]?routing\b/i,
  /\bstage[_\s]?aware\b/i,
];

// ── Objective-specific policy checks ──────────

interface ObjectiveCheck {
  /** Returns violations for this objective */
  check(content: string, ctx: EvalContext): PolicyViolation[];
}

interface EvalContext {
  primary_objective: ReplyObjective;
  secondary_objective: ReplyObjective | null;
  stage: string;
  suppressed_cta: string[];
  suppressed_offers: string[];
  preferred_cta: string[];
  latest_inbound: string;
  is_urgent: boolean;
}

// ── CTA detection patterns ──────────────

function detectCTAsInContent(content: string): string[] {
  const found: string[] = [];
  const t = content.toLowerCase();
  if (/\b(book|schedule|set up|arrange)\b.{0,30}\b(call|meeting|demo|time|slot)\b/i.test(content)) found.push("meeting_request");
  if (/\b(sign|commit|confirm|finalize|lock in|proceed|go ahead|place.{0,10}order)\b/i.test(content)) found.push("commitment");
  if (/\b(let me know|would.{0,15}(interest|helpful)|happy to|open to)\b/i.test(content)) found.push("soft_offer");
  if (/\b(quick question|curious|wondering)\b/i.test(content)) found.push("quick_question");
  if (/\b(special|limited|expir|offer ends|act now|hurry|last chance)\b/i.test(content)) found.push("urgency_close");
  if (/\b(check.{0,10}(in|back)|circle back|follow.{0,5}up|touch base)\b/i.test(content)) found.push("timing_check");
  if (/\b(discount|off|% off|coupon|promo)\b/i.test(content)) found.push("discount");
  if (/\b(trial|free|pilot|test drive|proof of concept|poc)\b/i.test(content)) found.push("trial_offer");
  return [...new Set(found)];
}

// ── Count distinct "goals" attempted in the reply ──

function countGoals(content: string): number {
  let goals = 0;
  const t = content.toLowerCase();
  // question-answering
  if (/\b(to answer|regarding your question|in response to|you asked)\b/i.test(content)) goals++;
  // objection handling
  if (/\b(understand your concern|appreciate the concern|valid point|great question about)\b/i.test(content)) goals++;
  // offer/pitch
  if (/\b(we offer|our solution|recommend|suggest|consider|check out)\b/i.test(content)) goals++;
  // meeting ask
  if (/\b(book|schedule|set up|arrange)\b.{0,30}\b(call|meeting|demo)\b/i.test(content)) goals++;
  // proof sharing
  if (/\b(case study|success story|attached|see the|here's a|proof)\b/i.test(content)) goals++;
  return goals;
}

// ── Word count helper ──

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// ── Objective-specific validators ──────────

const OBJECTIVE_CHECKS: Partial<Record<ReplyObjective, ObjectiveCheck>> = {
  answer_direct_question: {
    check(content, ctx) {
      const violations: PolicyViolation[] = [];
      // Must contain some form of answer before any commercial move
      const lines = content.split("\n").filter(l => l.trim());
      const firstSubstantialLine = lines.find(l => l.trim().length > 20) || "";
      const ctas = detectCTAsInContent(content);
      if (ctas.includes("meeting_request") || ctas.includes("commitment")) {
        // Check if the question was actually answered first
        const questionKeywords = ctx.latest_inbound.match(/\b(how|what|where|when|can|does|is)\b/gi) || [];
        if (questionKeywords.length > 0 && !/(to answer|here's|the answer|in short|specifically|yes|no,)/i.test(content.slice(0, 300))) {
          violations.push({ rule: "answer_before_cta", severity: "high", detail: "Meeting/commitment CTA used without first answering the prospect's question" });
        }
      }
      if (countGoals(content) > 2) {
        violations.push({ rule: "multi_goal_overload", severity: "medium", detail: "Reply tries to do too many things; primary objective is to answer a question" });
      }
      return violations;
    },
  },
  resolve_objection: {
    check(content, ctx) {
      const violations: PolicyViolation[] = [];
      if (!/(understand|appreciate|valid|fair|hear you|makes sense|reasonable)/i.test(content)) {
        violations.push({ rule: "missing_acknowledgment", severity: "high", detail: "Objection reply does not acknowledge the concern" });
      }
      const ctas = detectCTAsInContent(content);
      if (ctas.includes("commitment") || ctas.includes("urgency_close")) {
        violations.push({ rule: "wrong_cta_for_objection", severity: "high", detail: "Commitment/urgency CTA is wrong when handling an objection" });
      }
      return violations;
    },
  },
  provide_proof: {
    check(content, ctx) {
      const violations: PolicyViolation[] = [];
      if (!/(case study|example|data|result|metric|customer|testimonial|evidence|showed|achieved|saved|reduced|increased)/i.test(content)) {
        violations.push({ rule: "missing_proof", severity: "high", detail: "Proof objective selected but reply contains no concrete evidence" });
      }
      return violations;
    },
  },
  support_internal_buy_in: {
    check(content, ctx) {
      const violations: PolicyViolation[] = [];
      if (wordCount(content) > 250) {
        violations.push({ rule: "too_long_for_forward", severity: "medium", detail: "Internal buy-in reply should be concise and forwardable but exceeds 250 words" });
      }
      const ctas = detectCTAsInContent(content);
      if (ctas.includes("meeting_request")) {
        violations.push({ rule: "meeting_cta_buyin", severity: "medium", detail: "Avoid requesting a meeting with the decision-maker; let champion manage" });
      }
      return violations;
    },
  },
  resolve_logistics: {
    check(content, ctx) {
      const violations: PolicyViolation[] = [];
      if (/(we'd love to|happy to explore|let's set up a call to discuss)/i.test(content) && !/(delivery|shipping|stock|available|timeline|eta|fulfill)/i.test(content)) {
        violations.push({ rule: "vague_logistics", severity: "high", detail: "Logistics reply is vague/generic; should include concrete specifics" });
      }
      return violations;
    },
  },
  close_for_commitment: {
    check(content, ctx) {
      const violations: PolicyViolation[] = [];
      if (wordCount(content) > 150) {
        violations.push({ rule: "closing_too_verbose", severity: "medium", detail: "Closing reply should be short and action-oriented" });
      }
      if (/(discover|explore|learn more about|tell me more|what are your goals)/i.test(content)) {
        violations.push({ rule: "reopened_discovery", severity: "high", detail: "Closing reply reopened discovery instead of driving commitment" });
      }
      return violations;
    },
  },
  support_expansion_or_reorder: {
    check(content, ctx) {
      const violations: PolicyViolation[] = [];
      if (/(getting started|beginner|intro|onboard|welcome aboard|new to)/i.test(content)) {
        violations.push({ rule: "beginner_tone_for_expansion", severity: "medium", detail: "Expansion/reorder reply uses beginner language for existing customer" });
      }
      return violations;
    },
  },
};

// ── Suppressed CTA/offer checker ──────────

function checkSuppressedPatterns(content: string, ctx: EvalContext): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const detectedCtas = detectCTAsInContent(content);

  for (const cta of detectedCtas) {
    if (ctx.suppressed_cta.some(s => cta.includes(s) || s.includes(cta))) {
      violations.push({
        rule: "suppressed_cta_used",
        severity: "high",
        detail: `CTA "${cta}" detected but is suppressed for objective "${ctx.primary_objective}" at stage "${ctx.stage}"`,
      });
    }
  }

  return violations;
}

// ── Focus checker ──────────

function checkFocus(content: string, ctx: EvalContext): { score: number; violations: PolicyViolation[] } {
  const goals = countGoals(content);
  const violations: PolicyViolation[] = [];
  let score = 10;

  if (goals > 3) {
    score = 3;
    violations.push({ rule: "multi_goal_overload", severity: "high", detail: `Reply attempts ${goals} distinct goals; should focus on 1-2` });
  } else if (goals > 2) {
    score = 6;
    violations.push({ rule: "multi_goal_mild", severity: "medium", detail: `Reply attempts ${goals} goals; consider focusing more` });
  }

  // Over-pitching check: if objective is answer/proof/objection/logistics, penalize heavy offer language
  const answerObjectives: ReplyObjective[] = ["answer_direct_question", "resolve_objection", "provide_proof", "resolve_logistics"];
  if (answerObjectives.includes(ctx.primary_objective)) {
    const offerPatterns = content.match(/\b(we offer|our solution|pricing|package|plan|subscription|buy|purchase)\b/gi) || [];
    if (offerPatterns.length > 2) {
      score = Math.max(score - 3, 2);
      violations.push({ rule: "over_pitching", severity: "medium", detail: `Heavy offer language (${offerPatterns.length} instances) when objective is "${ctx.primary_objective}"` });
    }
  }

  return { score, violations };
}

// ── Leaked label checker ──────────

function checkLeakedLabels(content: string): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  for (const pattern of LEAKED_LABEL_PATTERNS) {
    if (pattern.test(content)) {
      violations.push({
        rule: "leaked_internal_label",
        severity: "high",
        detail: `Internal label leaked in output: matched pattern ${pattern.source}`,
      });
      break; // one is enough to flag
    }
  }
  return violations;
}

// ── Secondary objective check ──────────

function checkSecondaryObjective(content: string, ctx: EvalContext): PolicyViolation[] {
  if (!ctx.secondary_objective) return [];
  const violations: PolicyViolation[] = [];

  // Secondary objective should be "light-touch" — check if it dominates
  const goals = countGoals(content);
  // If secondary objective has heavy CTA presence, that's a violation
  const secondaryMeta: Record<string, string[]> = {
    move_to_meeting_or_call: ["meeting_request"],
    close_for_commitment: ["commitment"],
    guide_to_offer: ["direct_offer"],
    move_to_commercial_step: ["direct_offer", "commitment"],
  };

  const heavyCtas = secondaryMeta[ctx.secondary_objective] || [];
  const detected = detectCTAsInContent(content);
  const heavyPresent = heavyCtas.filter(c => detected.includes(c));
  if (heavyPresent.length > 0 && goals > 2) {
    violations.push({
      rule: "secondary_objective_dominant",
      severity: "medium",
      detail: `Secondary objective "${ctx.secondary_objective}" appears to dominate with CTA(s): ${heavyPresent.join(", ")}`,
    });
  }

  return violations;
}

// ── Main evaluator ──────────────────────

export function evaluateReply(
  content: string,
  replyObjective: { primary: ReplyObjective; secondary: ReplyObjective | null; confidence: string; override_source: string | null },
  stagePolicy: ResolvedPolicy,
  commercialDecision: ClassifiedDecision | undefined,
  latestInbound: string,
): ReplyEvaluation {
  const ctx: EvalContext = {
    primary_objective: replyObjective.primary,
    secondary_objective: replyObjective.secondary,
    stage: stagePolicy.effective_stage,
    suppressed_cta: stagePolicy.final_suppressed_cta ?? [],
    suppressed_offers: stagePolicy.final_suppressed_offer_categories ?? [],
    preferred_cta: stagePolicy.final_cta_strategy ? [stagePolicy.final_cta_strategy] : [],
    latest_inbound: latestInbound,
    is_urgent: stagePolicy.urgency?.is_urgent ?? false,
  };

  const allViolations: PolicyViolation[] = [];

  // 1. Leaked labels check
  allViolations.push(...checkLeakedLabels(content));

  // 2. Objective-specific checks
  const objectiveChecker = OBJECTIVE_CHECKS[ctx.primary_objective];
  if (objectiveChecker) {
    allViolations.push(...objectiveChecker.check(content, ctx));
  }

  // 3. Suppressed CTA/offer patterns
  allViolations.push(...checkSuppressedPatterns(content, ctx));

  // 4. Focus check
  const focusResult = checkFocus(content, ctx);
  allViolations.push(...focusResult.violations);

  // 5. Secondary objective dominance
  allViolations.push(...checkSecondaryObjective(content, ctx));

  // ── Scoring ──

  // Objective alignment: start at 10, deduct for objective-specific violations
  const highObjectiveViolations = allViolations.filter(v =>
    v.severity === "high" && ["answer_before_cta", "missing_acknowledgment", "missing_proof",
    "vague_logistics", "reopened_discovery", "wrong_cta_for_objection"].includes(v.rule)
  ).length;
  const objective_alignment_score = Math.max(10 - highObjectiveViolations * 4, 0);

  // CTA alignment: based on suppressed CTA violations
  const ctaViolations = allViolations.filter(v => v.rule === "suppressed_cta_used").length;
  const cta_alignment_score = Math.max(10 - ctaViolations * 3, 0);

  // Focus score from focus checker
  const focus_score = focusResult.score;

  // Commercial relevance: penalize leaked labels, over-pitching, beginner tone for expansion
  const commercialIssues = allViolations.filter(v =>
    ["leaked_internal_label", "over_pitching", "beginner_tone_for_expansion", "closing_too_verbose"].includes(v.rule)
  ).length;
  const commercial_relevance_score = Math.max(10 - commercialIssues * 3, 0);

  // Determine dominant orchestration layer
  let dominant_layer = "stage_policy";
  if (replyObjective.override_source) {
    dominant_layer = "reply_objective";
  } else if (commercialDecision && commercialDecision.detected_objection_classes.length > 0) {
    dominant_layer = "objection_classifier";
  } else if (commercialDecision && commercialDecision.detected_commercial_intent !== "none") {
    dominant_layer = "intent_classifier";
  }

  // Regeneration decision: high-severity violations
  const highViolations = allViolations.filter(v => v.severity === "high");
  const totalScore = objective_alignment_score + cta_alignment_score + focus_score + commercial_relevance_score;
  const regeneration_recommended = highViolations.length >= 2 || totalScore < 20;

  const evaluation_summary = regeneration_recommended
    ? `Reply failed policy check: ${highViolations.map(v => v.rule).join(", ")}. Total score: ${totalScore}/40.`
    : `Reply passed policy check. Score: ${totalScore}/40. ${allViolations.length > 0 ? `Minor issues: ${allViolations.filter(v => v.severity !== "high").map(v => v.rule).join(", ")}` : "No violations."}`;

  return {
    objective_alignment_score,
    cta_alignment_score,
    focus_score,
    commercial_relevance_score,
    policy_violations: allViolations,
    regeneration_recommended,
    evaluation_summary,
    dominant_layer,
  };
}

// ── Build evaluator feedback for regeneration prompt ──

export function buildEvaluatorFeedback(evaluation: ReplyEvaluation, objective: string): string {
  const highViolations = evaluation.policy_violations.filter(v => v.severity === "high");
  if (highViolations.length === 0) return "";

  const lines = [
    "=== EVALUATOR FEEDBACK (REGENERATION) ===",
    `The previous reply FAILED the policy check for objective: "${objective}".`,
    "Fix these specific issues:",
  ];

  for (const v of highViolations) {
    lines.push(`- [${v.rule}] ${v.detail}`);
  }

  lines.push("");
  lines.push("RULES for this regeneration:");
  lines.push("- Address ONLY the violations listed above");
  lines.push("- Keep the same overall structure and tone");
  lines.push("- Do NOT add new goals or CTAs not aligned with the objective");
  lines.push("- Do NOT leak internal labels, scores, or evaluation reasoning");

  return lines.join("\n");
}
