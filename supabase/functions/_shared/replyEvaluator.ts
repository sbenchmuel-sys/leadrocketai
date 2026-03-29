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
  dominant_layer: string;
}

// ── Leaked-label patterns ──

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

// ── EvalContext (all structured fields the evaluator needs) ──

interface EvalContext {
  primary_objective: ReplyObjective;
  secondary_objective: ReplyObjective | null;
  stage: string;
  final_cta_strategy: string;
  suppressed_cta: string[];
  suppressed_offers: string[];
  preferred_cta: string[];
  preferred_offers: string[];
  latest_inbound: string;
  is_urgent: boolean;
  has_internal_buyin: boolean;
  objection_classes: string[];
  // Deal memory continuity fields
  deal_shared_assets: string[];
  deal_sent_offers: string[];
  deal_recent_cta_patterns: string[];
  deal_momentum_state: string;
  deal_ignored_cta_count: number;
  deal_handled_objections: string[];
  deal_unanswered_questions: string[];
}

// ── CTA detection patterns ──

function detectCTAsInContent(content: string): string[] {
  const found: string[] = [];
  if (/\b(book|schedule|set up|arrange)\b.{0,30}\b(call|meeting|demo|time|slot)\b/i.test(content)) found.push("meeting_request");
  if (/\b(sign|commit|confirm|finalize|lock in|proceed|go ahead|place.{0,10}order)\b/i.test(content)) found.push("commitment");
  if (/\b(let me know|would.{0,15}(interest|helpful)|happy to|open to)\b/i.test(content)) found.push("soft_offer");
  if (/\b(quick question|curious|wondering)\b/i.test(content)) found.push("quick_question");
  if (/\b(special|limited|expir|offer ends|act now|hurry|last chance)\b/i.test(content)) found.push("urgency_close");
  if (/\b(check.{0,10}(in|back)|circle back|follow.{0,5}up|touch base)\b/i.test(content)) found.push("timing_check");
  if (/\b(discount|off|% off|coupon|promo)\b/i.test(content)) found.push("discount");
  if (/\b(trial|free|pilot|test drive|proof of concept|poc)\b/i.test(content)) found.push("trial_offer");
  if (/\b(here's|check out|take a look|see the|attached)\b.{0,30}\b(link|pdf|doc|guide|resource)\b/i.test(content)) found.push("direct_offer");
  return [...new Set(found)];
}

// ── Goal counter ──

function countGoals(content: string): number {
  let goals = 0;
  if (/\b(to answer|regarding your question|in response to|you asked)\b/i.test(content)) goals++;
  if (/\b(understand your concern|appreciate the concern|valid point|great question about)\b/i.test(content)) goals++;
  if (/\b(we offer|our solution|recommend|suggest|consider|check out)\b/i.test(content)) goals++;
  if (/\b(book|schedule|set up|arrange)\b.{0,30}\b(call|meeting|demo)\b/i.test(content)) goals++;
  if (/\b(case study|success story|attached|see the|here's a|proof)\b/i.test(content)) goals++;
  return goals;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// ── Suppressed offer mention detection ──

function detectOfferMentionsInContent(content: string, offers: string[]): string[] {
  const found: string[] = [];
  const lower = content.toLowerCase();
  for (const offer of offers) {
    const offerLower = offer.toLowerCase().replace(/_/g, " ");
    // Check both underscore and space variants
    if (lower.includes(offerLower) || lower.includes(offer.toLowerCase())) {
      found.push(offer);
    }
  }
  return found;
}

// ── Objective-specific validators ──

interface ObjectiveCheck {
  check(content: string, ctx: EvalContext): PolicyViolation[];
}

const OBJECTIVE_CHECKS: Partial<Record<ReplyObjective, ObjectiveCheck>> = {
  answer_direct_question: {
    check(content, ctx) {
      const violations: PolicyViolation[] = [];
      const ctas = detectCTAsInContent(content);
      if (ctas.includes("meeting_request") || ctas.includes("commitment")) {
        const questionKeywords = ctx.latest_inbound.match(/\b(how|what|where|when|can|does|is)\b/gi) || [];
        if (questionKeywords.length > 0 && !/(to answer|here's|the answer|in short|specifically|yes|no,)/i.test(content.slice(0, 300))) {
          violations.push({ rule: "answer_before_cta", severity: "high", detail: "CTA used without first answering the prospect's question" });
        }
      }
      if (countGoals(content) > 2) {
        violations.push({ rule: "multi_goal_overload", severity: "medium", detail: "Reply tries too many things; primary is answering a question" });
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
        violations.push({ rule: "wrong_cta_for_objection", severity: "high", detail: "Commitment/urgency CTA wrong when handling objection" });
      }
      // Should not pitch multiple offers while resolving
      if (countGoals(content) > 2) {
        violations.push({ rule: "multi_goal_objection", severity: "medium", detail: "Too many goals while resolving objection" });
      }
      return violations;
    },
  },
  provide_proof: {
    check(content, ctx) {
      const violations: PolicyViolation[] = [];
      if (!/(case study|example|data|result|metric|customer|testimonial|evidence|showed|achieved|saved|reduced|increased)/i.test(content)) {
        violations.push({ rule: "missing_proof", severity: "high", detail: "Proof objective but reply has no concrete evidence" });
      }
      if (countGoals(content) > 3) {
        violations.push({ rule: "proof_unfocused", severity: "medium", detail: "Proof reply tries too many things" });
      }
      return violations;
    },
  },
  support_internal_buy_in: {
    check(content, ctx) {
      const violations: PolicyViolation[] = [];
      if (wordCount(content) > 250) {
        violations.push({ rule: "too_long_for_forward", severity: "medium", detail: "Internal buy-in reply exceeds 250 words; not forwardable" });
      }
      const ctas = detectCTAsInContent(content);
      if (ctas.includes("meeting_request")) {
        violations.push({ rule: "meeting_cta_buyin", severity: "medium", detail: "Avoid meeting CTA for internal buy-in; let champion manage" });
      }
      // Should contain shareable proof
      if (!/(summary|one.?pager|overview|roi|key (benefit|point|result)|highlight)/i.test(content)) {
        violations.push({ rule: "missing_shareable_asset", severity: "low", detail: "Internal buy-in reply lacks shareable/summary content" });
      }
      return violations;
    },
  },
  resolve_logistics: {
    check(content, ctx) {
      const violations: PolicyViolation[] = [];
      if (!/(delivery|shipping|stock|available|timeline|eta|fulfill|lead time|warehouse|pickup|days|weeks|business day)/i.test(content)) {
        violations.push({ rule: "vague_logistics", severity: "high", detail: "Logistics reply lacks concrete specifics" });
      }
      // If urgent, should not defer
      if (ctx.is_urgent && /(let me get back|I'll check|need to confirm|circle back)/i.test(content)) {
        violations.push({ rule: "urgent_deferred", severity: "medium", detail: "Urgent logistics but reply defers answer" });
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
        violations.push({ rule: "reopened_discovery", severity: "high", detail: "Closing reply reopened discovery" });
      }
      const ctas = detectCTAsInContent(content);
      if (!ctas.includes("commitment") && !ctas.includes("meeting_request")) {
        violations.push({ rule: "weak_closing_cta", severity: "medium", detail: "Closing reply lacks commitment or meeting CTA" });
      }
      return violations;
    },
  },
  support_expansion_or_reorder: {
    check(content, ctx) {
      const violations: PolicyViolation[] = [];
      if (/(getting started|beginner|intro|onboard|welcome aboard|new to)/i.test(content)) {
        violations.push({ rule: "beginner_tone_for_expansion", severity: "medium", detail: "Expansion reply uses beginner language" });
      }
      return violations;
    },
  },
  guide_to_offer: {
    check(content, ctx) {
      const violations: PolicyViolation[] = [];
      // Should mention at most 1-2 offers
      const offerMentions = (content.match(/\b(offer|option|package|plan|bundle|product)\b/gi) || []).length;
      if (offerMentions > 4) {
        violations.push({ rule: "catalog_dump", severity: "medium", detail: "Guide-to-offer reply presents too many options (catalog dump)" });
      }
      return violations;
    },
  },
  move_to_meeting_or_call: {
    check(content, ctx) {
      const violations: PolicyViolation[] = [];
      const ctas = detectCTAsInContent(content);
      if (!ctas.includes("meeting_request")) {
        violations.push({ rule: "missing_meeting_cta", severity: "medium", detail: "Move-to-meeting objective but no meeting CTA detected" });
      }
      return violations;
    },
  },
  low_pressure_hold_or_nurture: {
    check(content, ctx) {
      const violations: PolicyViolation[] = [];
      const ctas = detectCTAsInContent(content);
      if (ctas.includes("commitment") || ctas.includes("urgency_close")) {
        violations.push({ rule: "pressure_in_nurture", severity: "high", detail: "Low-pressure hold used commitment/urgency CTA" });
      }
      return violations;
    },
  },
};

// ── Suppressed CTA checker ──

function checkSuppressedPatterns(content: string, ctx: EvalContext): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const detectedCtas = detectCTAsInContent(content);

  for (const cta of detectedCtas) {
    if (ctx.suppressed_cta.some(s => cta.includes(s) || s.includes(cta))) {
      violations.push({
        rule: "suppressed_cta_used",
        severity: "high",
        detail: `CTA "${cta}" is suppressed for "${ctx.primary_objective}" at stage "${ctx.stage}"`,
      });
    }
  }

  // Check suppressed offer categories mentioned
  const suppressedOfferMentions = detectOfferMentionsInContent(content, ctx.suppressed_offers);
  for (const offer of suppressedOfferMentions) {
    violations.push({
      rule: "suppressed_offer_mentioned",
      severity: "medium",
      detail: `Suppressed offer category "${offer}" mentioned in reply`,
    });
  }

  return violations;
}

// ── Focus checker ──

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

  // Over-pitching check for answer/proof/objection/logistics objectives
  const answerObjectives: ReplyObjective[] = ["answer_direct_question", "resolve_objection", "provide_proof", "resolve_logistics"];
  if (answerObjectives.includes(ctx.primary_objective)) {
    const offerPatterns = content.match(/\b(we offer|our solution|pricing|package|plan|subscription|buy|purchase)\b/gi) || [];
    if (offerPatterns.length > 2) {
      score = Math.max(score - 3, 2);
      violations.push({ rule: "over_pitching", severity: "medium", detail: `Heavy offer language (${offerPatterns.length}×) for "${ctx.primary_objective}"` });
    }
  }

  return { score, violations };
}

// ── Leaked label checker ──

function checkLeakedLabels(content: string): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  for (const pattern of LEAKED_LABEL_PATTERNS) {
    if (pattern.test(content)) {
      violations.push({
        rule: "leaked_internal_label",
        severity: "high",
        detail: `Internal label leaked: matched ${pattern.source}`,
      });
      break;
    }
  }
  return violations;
}

// ── Secondary objective dominance check ──

function checkSecondaryObjective(content: string, ctx: EvalContext): PolicyViolation[] {
  if (!ctx.secondary_objective) return [];
  const violations: PolicyViolation[] = [];

  const secondaryMeta: Record<string, string[]> = {
    move_to_meeting_or_call: ["meeting_request"],
    close_for_commitment: ["commitment"],
    guide_to_offer: ["direct_offer"],
    move_to_commercial_step: ["direct_offer", "commitment"],
  };

  const heavyCtas = secondaryMeta[ctx.secondary_objective] || [];
  const detected = detectCTAsInContent(content);
  const heavyPresent = heavyCtas.filter(c => detected.includes(c));
  if (heavyPresent.length > 0 && countGoals(content) > 2) {
    violations.push({
      rule: "secondary_objective_dominant",
      severity: "medium",
      detail: `Secondary "${ctx.secondary_objective}" dominates with CTA(s): ${heavyPresent.join(", ")}`,
    });
  }

  return violations;
}

// ── CTA alignment with selected strategy ──

function checkCtaAlignment(content: string, ctx: EvalContext): { score: number; violations: PolicyViolation[] } {
  const violations: PolicyViolation[] = [];
  const detectedCtas = detectCTAsInContent(content);
  let score = 10;

  // If a specific CTA strategy is set, check alignment
  if (ctx.final_cta_strategy && detectedCtas.length > 0) {
    const strategyAligned = detectedCtas.some(c =>
      c === ctx.final_cta_strategy ||
      ctx.preferred_cta.some(p => c.includes(p) || p.includes(c))
    );
    if (!strategyAligned && detectedCtas.length > 0) {
      score = Math.max(score - 3, 3);
      violations.push({
        rule: "cta_misaligned",
        severity: "low",
        detail: `Detected CTAs [${detectedCtas.join(",")}] don't match strategy "${ctx.final_cta_strategy}"`,
      });
    }
  }

  return { score, violations };
}

// ── Urgency alignment check ──

function checkUrgencyAlignment(content: string, ctx: EvalContext): PolicyViolation[] {
  if (!ctx.is_urgent) return [];
  const violations: PolicyViolation[] = [];

  // Urgent signals should not produce nurture/slow responses
  if (/(no rush|take your time|whenever|next quarter|circle back later)/i.test(content)) {
    violations.push({
      rule: "urgency_ignored",
      severity: "high",
      detail: "Urgency detected but reply uses slow/nurture language",
    });
  }

  return violations;
}

// ── Internal buy-in alignment check ──

function checkBuyinAlignment(content: string, ctx: EvalContext): PolicyViolation[] {
  if (!ctx.has_internal_buyin) return [];
  if (ctx.primary_objective === "support_internal_buy_in") return []; // already checked
  const violations: PolicyViolation[] = [];

  // If internal buy-in is detected but not the primary objective, at least don't contradict it
  if (/(just between us|don't share|confidential|this is private)/i.test(content)) {
    violations.push({
      rule: "buyin_anti_forward",
      severity: "medium",
      detail: "Internal buy-in context but reply uses non-forwardable language",
    });
  }

  return violations;
}

// ── Continuity checks (deal memory) ──

function checkContinuity(content: string, ctx: EvalContext): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const lower = content.toLowerCase();

  // ── 1. Repeated asset reuse (MEDIUM severity — escalates to HIGH with multiple) ──
  const reusedAssets: string[] = [];
  for (const asset of ctx.deal_shared_assets) {
    const assetLower = asset.replace(/_/g, " ");
    if (lower.includes(assetLower)) {
      reusedAssets.push(asset);
    }
  }
  if (reusedAssets.length > 0) {
    violations.push({
      rule: "repeated_asset_reuse",
      severity: reusedAssets.length >= 2 ? "high" : "medium",
      detail: `Asset(s) already shared: ${reusedAssets.join(", ")}. Use different proof or reference the existing one briefly.`,
    });
  }

  // ── 2. Repeated offer reuse (MEDIUM severity) ──
  const reusedOffers: string[] = [];
  for (const offer of ctx.deal_sent_offers) {
    const offerLower = offer.toLowerCase().replace(/_/g, " ");
    if (lower.includes(offerLower)) {
      reusedOffers.push(offer);
    }
  }
  if (reusedOffers.length > 0) {
    violations.push({
      rule: "repeated_offer_reuse",
      severity: "medium",
      detail: `Offer(s) already sent: ${reusedOffers.join(", ")}. Recommend a different offer or reference the existing one.`,
    });
  }

  // ── 3. CTA fatigue — same pattern 2+ times in a row (MEDIUM/HIGH) ──
  if (ctx.deal_recent_cta_patterns.length >= 2) {
    const last2 = ctx.deal_recent_cta_patterns.slice(-2);
    if (last2[0] === last2[1]) {
      const detectedCtas = detectCTAsInContent(content);
      if (detectedCtas.includes(last2[0])) {
        const isThreeOrMore = ctx.deal_recent_cta_patterns.length >= 3 && 
          ctx.deal_recent_cta_patterns.slice(-3).every(c => c === last2[0]);
        violations.push({
          rule: "cta_fatigue",
          severity: isThreeOrMore ? "high" : "medium",
          detail: `CTA "${last2[0]}" used ${isThreeOrMore ? "3+" : "2"} times consecutively — vary the approach`,
        });
      }
    }
  }

  // ── 4. False progress claims when stalled/regressing (HIGH) ──
  if (ctx.deal_momentum_state === "stalled" || ctx.deal_momentum_state === "regressing") {
    if (/(momentum|great progress|moving forward|exciting.*progress|things are going well|picking up|gaining traction)/i.test(content)) {
      violations.push({
        rule: "false_progress_claim",
        severity: "high",
        detail: `Reply claims progress but deal momentum is ${ctx.deal_momentum_state}`,
      });
    }
    // Also flag aggressive closing when stalled
    const detectedCtas = detectCTAsInContent(content);
    if (detectedCtas.includes("commitment") || detectedCtas.includes("urgency_close")) {
      violations.push({
        rule: "aggressive_close_when_stalled",
        severity: "high",
        detail: `Deal is ${ctx.deal_momentum_state} but reply uses aggressive closing CTA`,
      });
    }
  }

  // ── 5. Ignored CTA escalation (MEDIUM/HIGH) ──
  if (ctx.deal_ignored_cta_count >= 2) {
    const detectedCtas = detectCTAsInContent(content);
    const isHeavy = detectedCtas.includes("commitment") || detectedCtas.includes("urgency_close") || detectedCtas.includes("meeting_request");
    if (isHeavy) {
      violations.push({
        rule: "heavy_cta_despite_fatigue",
        severity: ctx.deal_ignored_cta_count >= 3 ? "high" : "medium",
        detail: `${ctx.deal_ignored_cta_count} CTAs ignored — reply should use lighter approach, not ${detectedCtas.filter(c => ["commitment", "urgency_close", "meeting_request"].includes(c)).join("/")}`,
      });
    }
  }

  // ── 6. Re-handling already-handled objections without need ──
  if (ctx.deal_handled_objections.length > 0) {
    for (const obj of ctx.deal_handled_objections) {
      const objLower = obj.toLowerCase().replace(/_/g, " ");
      // Check if reply is addressing this objection
      if (lower.includes(objLower) && /(understand|concern|worry|addressed|noted|previously)/i.test(content)) {
        // Only flag if the latest inbound doesn't contain this objection topic
        const inboundLower = ctx.latest_inbound.toLowerCase();
        if (!inboundLower.includes(objLower)) {
          violations.push({
            rule: "rehandling_resolved_objection",
            severity: "medium",
            detail: `Objection "${obj}" was already handled — do not re-address unless prospect raises it again`,
          });
          break; // Only flag once
        }
      }
    }
  }

  // ── 7. Unanswered questions ignored (LOW — informational) ──
  if (ctx.deal_unanswered_questions.length > 0 && ctx.primary_objective !== "answer_direct_question") {
    // Check if any unanswered question topics appear addressable from inbound
    const hasRelevantQuestion = ctx.deal_unanswered_questions.some(q => {
      const keywords = q.split(/\s+/).filter(w => w.length > 4).slice(0, 3);
      return keywords.some(kw => lower.includes(kw.toLowerCase()));
    });
    if (!hasRelevantQuestion && ctx.deal_unanswered_questions.length >= 2) {
      violations.push({
        rule: "unanswered_questions_ignored",
        severity: "low",
        detail: `${ctx.deal_unanswered_questions.length} unanswered prospect questions pending — consider addressing`,
      });
    }
  }

  return violations;
}

// ── Main evaluator ──────────────────────

export interface DealMemoryEvalContext {
  shared_assets?: string[];
  sent_offers?: string[];
  recent_cta_patterns?: string[];
  momentum_state?: string;
  ignored_cta_count?: number;
  handled_objections?: string[];
  unanswered_questions?: string[];
}

export function evaluateReply(
  content: string,
  replyObjective: {
    primary: ReplyObjective;
    secondary: ReplyObjective | null;
    confidence: string;
    override_source: string | null;
  },
  stagePolicy: ResolvedPolicy,
  commercialDecision: ClassifiedDecision | undefined,
  latestInbound: string,
  dealMemoryCtx?: DealMemoryEvalContext,
): ReplyEvaluation {
  const ctx: EvalContext = {
    primary_objective: replyObjective.primary,
    secondary_objective: replyObjective.secondary,
    stage: stagePolicy.effective_stage,
    final_cta_strategy: stagePolicy.final_cta_strategy,
    suppressed_cta: stagePolicy.final_suppressed_cta_patterns ?? [],
    suppressed_offers: stagePolicy.final_suppressed_offer_categories ?? [],
    preferred_cta: stagePolicy.final_preferred_cta_patterns ?? [],
    preferred_offers: stagePolicy.final_preferred_offer_categories ?? [],
    latest_inbound: latestInbound || "",
    is_urgent: stagePolicy.urgency?.is_urgent ?? false,
    has_internal_buyin: commercialDecision?.detected_objection_classes?.includes("internal_buy_in") ?? false,
    objection_classes: commercialDecision?.detected_objection_classes ?? [],
    // Deal memory continuity
    deal_shared_assets: dealMemoryCtx?.shared_assets ?? [],
    deal_sent_offers: dealMemoryCtx?.sent_offers ?? [],
    deal_recent_cta_patterns: dealMemoryCtx?.recent_cta_patterns ?? [],
    deal_momentum_state: dealMemoryCtx?.momentum_state ?? "unknown",
    deal_ignored_cta_count: dealMemoryCtx?.ignored_cta_count ?? 0,
  };

  const allViolations: PolicyViolation[] = [];

  // 1. Leaked labels
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

  // 6. CTA alignment with strategy
  const ctaResult = checkCtaAlignment(content, ctx);
  allViolations.push(...ctaResult.violations);

  // 7. Urgency alignment
  allViolations.push(...checkUrgencyAlignment(content, ctx));

  // 8. Internal buy-in alignment
  allViolations.push(...checkBuyinAlignment(content, ctx));

  // 9. Deal memory continuity checks
  allViolations.push(...checkContinuity(content, ctx));

  // ── Scoring ──

  // Objective alignment: high-severity objective-specific violations
  const objectiveViolationRules = [
    "answer_before_cta", "missing_acknowledgment", "missing_proof",
    "vague_logistics", "reopened_discovery", "wrong_cta_for_objection",
    "urgency_ignored", "pressure_in_nurture", "weak_closing_cta",
  ];
  const highObjectiveViolations = allViolations.filter(v =>
    v.severity === "high" && objectiveViolationRules.includes(v.rule)
  ).length;
  const objective_alignment_score = Math.max(10 - highObjectiveViolations * 4, 0);

  // CTA alignment: suppressed CTA + misalignment
  const ctaViolationCount = allViolations.filter(v =>
    v.rule === "suppressed_cta_used" || v.rule === "cta_misaligned"
  ).length;
  const cta_alignment_score = Math.max(10 - ctaViolationCount * 3, 0);

  // Focus score
  const focus_score = focusResult.score;

  // Commercial relevance
  const commercialIssueRules = [
    "leaked_internal_label", "over_pitching", "beginner_tone_for_expansion",
    "closing_too_verbose", "suppressed_offer_mentioned", "buyin_anti_forward",
  ];
  const commercialIssues = allViolations.filter(v =>
    commercialIssueRules.includes(v.rule)
  ).length;
  const commercial_relevance_score = Math.max(10 - commercialIssues * 3, 0);

  // Dominant layer
  let dominant_layer = "stage_policy";
  if (replyObjective.override_source) {
    dominant_layer = "reply_objective";
  } else if (commercialDecision && commercialDecision.detected_objection_classes.length > 0) {
    dominant_layer = "objection_classifier";
  } else if (commercialDecision && commercialDecision.detected_commercial_intent !== "none") {
    dominant_layer = "intent_classifier";
  }

  // Regeneration: require BOTH low total AND low objective alignment
  const highViolations = allViolations.filter(v => v.severity === "high");
  const totalScore = objective_alignment_score + cta_alignment_score + focus_score + commercial_relevance_score;
  const regeneration_recommended =
    (highViolations.length >= 2 && objective_alignment_score < 6) ||
    (totalScore < 20 && objective_alignment_score < 6) ||
    (highViolations.length >= 3);

  const evaluation_summary = regeneration_recommended
    ? `Reply failed: ${highViolations.map(v => v.rule).join(", ")}. Score: ${totalScore}/40 (obj=${objective_alignment_score}).`
    : `Reply OK. Score: ${totalScore}/40.${allViolations.length > 0 ? ` Minor: ${allViolations.filter(v => v.severity !== "high").map(v => v.rule).join(", ")}` : ""}`;

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

// ── Build evaluator feedback for regeneration ──

export function buildEvaluatorFeedback(evaluation: ReplyEvaluation, objective: string): string {
  const highViolations = evaluation.policy_violations.filter(v => v.severity === "high");
  if (highViolations.length === 0) return "";

  const lines = [
    "=== EVALUATOR FEEDBACK (REGENERATION) ===",
    `Previous reply FAILED policy check for objective: "${objective}".`,
    "Fix these issues:",
  ];

  for (const v of highViolations) {
    lines.push(`- [${v.rule}] ${v.detail}`);
  }

  lines.push(
    "",
    "RULES:",
    "- Fix ONLY the violations above",
    "- Keep same structure and tone",
    "- Do NOT add goals/CTAs not aligned with the objective",
    "- Do NOT leak internal labels or reasoning",
  );

  return lines.join("\n");
}

// ── Test scenarios (exported for validation) ──

export interface EvalTestScenario {
  name: string;
  objective: ReplyObjective;
  stage: string;
  content: string;
  latest_inbound: string;
  is_urgent: boolean;
  expected_violations: string[];
  expected_regen: boolean;
}

export const EVAL_TEST_SCENARIOS: EvalTestScenario[] = [
  {
    name: "direct_question_answered",
    objective: "answer_direct_question",
    stage: "active_eval",
    content: "To answer your question, the minimum order quantity is 500 units. We also offer flexible batching. Let me know if this works for your needs.",
    latest_inbound: "What is the minimum order quantity?",
    is_urgent: false,
    expected_violations: [],
    expected_regen: false,
  },
  {
    name: "direct_question_ignored_meeting_pushed",
    objective: "answer_direct_question",
    stage: "active_eval",
    content: "Great question! I'd love to schedule a call to walk you through our capabilities. How about Thursday at 2pm?",
    latest_inbound: "What is the minimum order quantity?",
    is_urgent: false,
    expected_violations: ["answer_before_cta"],
    expected_regen: false,
  },
  {
    name: "objection_acknowledged",
    objective: "resolve_objection",
    stage: "objection",
    content: "I completely understand your budget concern. Many of our customers had similar worries. Here's a case study showing 3x ROI within 6 months. Would a pilot program help you test the waters?",
    latest_inbound: "The pricing seems too high for our budget.",
    is_urgent: false,
    expected_violations: [],
    expected_regen: false,
  },
  {
    name: "objection_dismissed_with_close",
    objective: "resolve_objection",
    stage: "objection",
    content: "Let's finalize your order today and lock in current pricing before rates go up!",
    latest_inbound: "The pricing seems too high for our budget.",
    is_urgent: false,
    expected_violations: ["missing_acknowledgment", "wrong_cta_for_objection"],
    expected_regen: true,
  },
  {
    name: "proof_provided",
    objective: "provide_proof",
    stage: "active_eval",
    content: "Here's a case study from a similar company in your industry. They achieved a 40% reduction in processing time within 3 months. Happy to share more details if helpful.",
    latest_inbound: "Can you share some examples of results?",
    is_urgent: false,
    expected_violations: [],
    expected_regen: false,
  },
  {
    name: "logistics_urgent_concrete",
    objective: "resolve_logistics",
    stage: "commercial",
    content: "We have 200 units available in our east coast warehouse. Standard delivery is 3-5 business days, but we can do express 1-2 day shipping for urgent orders. I'll reserve stock for you now.",
    latest_inbound: "We need 200 units delivered by Friday, is that possible?",
    is_urgent: true,
    expected_violations: [],
    expected_regen: false,
  },
  {
    name: "logistics_urgent_vague",
    objective: "resolve_logistics",
    stage: "commercial",
    content: "We'd love to help! Let me check with the team and circle back on availability. In the meantime, would you like to explore our premium options?",
    latest_inbound: "We need 200 units delivered by Friday, is that possible?",
    is_urgent: true,
    expected_violations: ["vague_logistics", "urgent_deferred"],
    expected_regen: true,
  },
  {
    name: "internal_buyin_concise",
    objective: "support_internal_buy_in",
    stage: "closing",
    content: "Here's a one-pager summarizing our key benefits and ROI data you can share with your team. Key highlights: 40% cost reduction, 99.9% uptime, dedicated support.",
    latest_inbound: "I need to run this by my CFO. Can you send something I can forward?",
    is_urgent: false,
    expected_violations: [],
    expected_regen: false,
  },
  {
    name: "closing_clean",
    objective: "close_for_commitment",
    stage: "closing",
    content: "Great to hear you're ready to move forward! I've prepared the agreement. You can sign electronically here. Once confirmed, we'll begin onboarding Monday.",
    latest_inbound: "Let's go ahead with the standard package.",
    is_urgent: false,
    expected_violations: [],
    expected_regen: false,
  },
  {
    name: "expansion_no_beginner",
    objective: "support_expansion_or_reorder",
    stage: "expansion",
    content: "Thanks for the reorder! Based on your volume history, you qualify for our loyalty tier which includes a dedicated account manager and priority fulfillment.",
    latest_inbound: "We'd like to place another order, same as last time but double the quantity.",
    is_urgent: false,
    expected_violations: [],
    expected_regen: false,
  },
];
