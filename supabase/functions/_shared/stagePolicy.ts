// ============================================
// STAGE-AWARE DECISION POLICY
// Last-mile selling control layer
// ============================================

import type { ClassifiedDecision, ObjectionClass } from "./intentClassifier.ts";

// ── Deal stages ────────────────────────────

export const DEAL_STAGES = [
  "engaged",        // early evaluation
  "active_eval",    // active evaluation (mapped from "contacted" with inbound)
  "objection",      // objection handling (derived, not stored)
  "commercial",     // commercial discussion (pricing/terms mentioned)
  "closing",        // commitment stage (post_meeting, negotiation)
  "expansion",      // repeat order / expansion
] as const;

export type DealStage = typeof DEAL_STAGES[number];

// ── Urgency modifier ──────────────────────

export interface UrgencySignal {
  is_urgent: boolean;
  confidence: number;
}

const URGENCY_PATTERNS = [
  /urgent|asap|rush|right away|immediately|as soon as possible|need.*today|need.*tomorrow|time.?sensitive/i,
  /deadline|by (monday|tuesday|wednesday|thursday|friday|end of week|eow|eom)/i,
  /can you.*fast|quick turnaround|expedite|priority order|same.?day/i,
];

export function detectUrgency(text: string): UrgencySignal {
  if (!text || text.length < 5) return { is_urgent: false, confidence: 0 };
  let matches = 0;
  for (const p of URGENCY_PATTERNS) {
    if (p.test(text)) matches++;
  }
  if (matches >= 2) return { is_urgent: true, confidence: 0.9 };
  if (matches === 1) return { is_urgent: true, confidence: 0.65 };
  return { is_urgent: false, confidence: 0 };
}

// ── Stage policy definition ───────────────

export interface StagePolicy {
  stage: DealStage;
  response_style: string;
  proof_style: string;
  preferred_cta_patterns: string[];
  suppressed_cta_patterns: string[];
  preferred_offer_categories: string[];
  suppressed_offer_categories: string[];
  preferred_kb_types: string[];
  escalation_rules: string[];
}

const STAGE_POLICIES: Record<DealStage, StagePolicy> = {
  engaged: {
    stage: "engaged",
    response_style: "Helpful, educational, low-pressure. Focus on understanding their needs.",
    proof_style: "Broad case studies, industry examples, introductory proof points",
    preferred_cta_patterns: ["soft_offer", "quick_question", "consultation", "permission_based"],
    suppressed_cta_patterns: ["commitment", "contract", "close_now"],
    preferred_offer_categories: ["starter", "consultation", "sample", "trial", "training"],
    suppressed_offer_categories: ["enterprise", "premium", "bulk"],
    preferred_kb_types: ["knowledge", "case_study", "messaging"],
    escalation_rules: [
      "If prospect shows strong buying signals, suggest moving to active evaluation",
      "If prospect asks pricing directly, treat as commercial discussion",
    ],
  },
  active_eval: {
    stage: "active_eval",
    response_style: "Responsive, thorough, solution-oriented. Address questions directly with supporting evidence.",
    proof_style: "Targeted case studies matching their use case, technical specs, comparison data",
    preferred_cta_patterns: ["soft_offer", "proof_based", "demo", "meeting_request"],
    suppressed_cta_patterns: ["close_now", "breakup_close"],
    preferred_offer_categories: ["demo", "sample", "trial", "comparison_guide", "product_specific"],
    suppressed_offer_categories: ["nurture_asset", "newsletter"],
    preferred_kb_types: ["knowledge", "case_study", "objection", "competitor"],
    escalation_rules: [
      "If prospect mentions budget or pricing, incorporate ROI proof",
      "If prospect mentions competitors, use non-defensive differentiation",
    ],
  },
  objection: {
    stage: "objection",
    response_style: "Empathetic, evidence-led, non-defensive. Acknowledge the concern before providing proof.",
    proof_style: "Specific proof addressing the exact objection: ROI data for budget, success stories for quality, implementation timelines for effort",
    preferred_cta_patterns: ["proof_based", "soft_offer", "consultation", "easy_forward"],
    suppressed_cta_patterns: ["direct_offer", "commitment", "close_now", "breakup_close"],
    preferred_offer_categories: ["sample", "trial", "case_study_asset", "roi_calculator", "implementation_support"],
    suppressed_offer_categories: ["urgency", "limited_time", "discount"],
    preferred_kb_types: ["objection", "case_study", "knowledge"],
    escalation_rules: [
      "If objection is resolved, guide back to commercial discussion",
      "If multiple objections surface, focus on the primary one first",
      "Do not stack multiple offers when handling an objection",
    ],
  },
  commercial: {
    stage: "commercial",
    response_style: "Direct, confident, value-focused. Lead with concrete options and next steps.",
    proof_style: "ROI data, pricing justification, value comparison, customer success metrics",
    preferred_cta_patterns: ["direct_offer", "meeting_request", "soft_offer", "timing_check"],
    suppressed_cta_patterns: ["breakup_close", "permission_based"],
    preferred_offer_categories: ["product_specific", "financing", "volume_pricing", "demo", "roi_calculator"],
    suppressed_offer_categories: ["nurture_asset", "newsletter", "beginner"],
    preferred_kb_types: ["knowledge", "case_study", "objection", "messaging"],
    escalation_rules: [
      "If prospect signals readiness, move to commitment-oriented CTA",
      "If prospect hesitates on price, do not discount — lead with value proof",
    ],
  },
  closing: {
    stage: "closing",
    response_style: "Commitment-oriented, concise, action-focused. Remove friction, confirm next steps.",
    proof_style: "Final reassurance: summary assets, ROI snapshots, implementation timelines, executive briefs",
    preferred_cta_patterns: ["direct_offer", "commitment", "easy_forward", "meeting_request"],
    suppressed_cta_patterns: ["quick_question", "permission_based", "breakup_close", "soft_offer"],
    preferred_offer_categories: ["summary_asset", "one_pager", "roi_summary", "executive_brief", "implementation_support"],
    suppressed_offer_categories: ["starter", "beginner", "trial", "newsletter", "nurture_asset"],
    preferred_kb_types: ["case_study", "knowledge", "objection"],
    escalation_rules: [
      "If prospect reopens discovery, respond briefly but steer back to commitment",
      "If internal buy-in is needed, provide easy-to-forward summary assets",
      "Do not introduce new exploratory content at this stage",
    ],
  },
  expansion: {
    stage: "expansion",
    response_style: "Account-growth oriented, appreciative, direct. Treat as an existing relationship.",
    proof_style: "Scaling success stories, volume benefits, loyalty proof, new product introductions",
    preferred_cta_patterns: ["direct_offer", "soft_offer", "meeting_request"],
    suppressed_cta_patterns: ["permission_based", "breakup_close", "quick_question"],
    preferred_offer_categories: ["bulk", "rewards", "repeat_order", "volume_pricing", "dedicated_support", "product_specific"],
    suppressed_offer_categories: ["starter", "beginner", "trial", "consultation", "training"],
    preferred_kb_types: ["knowledge", "case_study"],
    escalation_rules: [
      "Even if beginner-like language appears, do not downgrade to starter paths",
      "Focus on growth opportunities within their existing relationship",
    ],
  },
};

// ── Map raw lead stage to deal stage ──────

export function mapToDealStage(
  rawStage: string,
  objectionClasses: ObjectionClass[],
  hasPricingMention: boolean,
  isRepeatCustomer: boolean,
): DealStage {
  // Expansion takes precedence
  if (isRepeatCustomer || rawStage === "closed") return "expansion";

  // Objection handling if strong objections detected
  const hasStrongObjection = objectionClasses.length > 0 &&
    !objectionClasses.every(o => o === "direct_product_interest");
  
  // Closing stage
  if (rawStage === "closing" || rawStage === "post_meeting") {
    return hasStrongObjection ? "objection" : "closing";
  }

  // Commercial discussion if pricing mentioned
  if (hasPricingMention || rawStage === "negotiation") {
    return hasStrongObjection ? "objection" : "commercial";
  }

  // Engaged with inbound = active eval
  if (rawStage === "engaged") {
    if (hasStrongObjection) return "objection";
    return "active_eval";
  }

  // Contacted = early engaged
  if (rawStage === "contacted") return "engaged";

  // New = engaged (default)
  return "engaged";
}

// ── Conflict resolution ───────────────────

export interface ResolvedPolicy {
  effective_stage: DealStage;
  final_response_style: string;
  final_proof_style: string;
  final_cta_strategy: string;
  final_preferred_cta_patterns: string[];
  final_suppressed_cta_patterns: string[];
  final_preferred_offer_categories: string[];
  final_suppressed_offer_categories: string[];
  final_preferred_kb_types: string[];
  stage_reasoning: string;
  urgency: UrgencySignal;
}

export function resolveStagePolicy(
  rawStage: string,
  decision: ClassifiedDecision,
  latestInbound: string,
  isRepeatCustomer: boolean,
): ResolvedPolicy {
  const hasPricing = /pric|cost|budget|invest|roi\b|financ|afford|payment/i.test(latestInbound || "");
  const urgency = detectUrgency(latestInbound || "");

  const effectiveStage = mapToDealStage(
    rawStage,
    decision.detected_objection_classes,
    hasPricing,
    isRepeatCustomer,
  );

  const policy = STAGE_POLICIES[effectiveStage];
  const reasons: string[] = [`raw_stage=${rawStage}`, `effective=${effectiveStage}`];

  // Start with stage defaults
  let finalCta = decision.cta_strategy || policy.preferred_cta_patterns[0] || "soft_offer";
  const preferredCta = [...policy.preferred_cta_patterns];
  const suppressedCta = [...policy.suppressed_cta_patterns];
  const preferredOffers = [...policy.preferred_offer_categories];
  const suppressedOffers = [...policy.suppressed_offer_categories];
  const preferredKb = [...policy.preferred_kb_types];

  // ── Conflict resolution rules ────────────

  const objections = decision.detected_objection_classes;

  // Rule 1: Direct product interest + budget → answer product first, guide to commercial path
  if (objections.includes("direct_product_interest") && objections.includes("budget")) {
    finalCta = "soft_offer";
    if (!preferredOffers.includes("product_specific")) preferredOffers.unshift("product_specific");
    if (!preferredOffers.includes("financing")) preferredOffers.push("financing");
    reasons.push("conflict:product+budget→product_first_then_finance");
  }

  // Rule 2: Internal buy-in during closing → easy-forward assets
  if (objections.includes("internal_buy_in") && effectiveStage === "closing") {
    finalCta = "easy_forward";
    for (const cat of ["summary_asset", "one_pager", "roi_summary", "executive_brief"]) {
      if (!preferredOffers.includes(cat)) preferredOffers.unshift(cat);
    }
    reasons.push("conflict:internal_buyin_at_closing→easy_forward");
  }

  // Rule 3: Closing stage → suppress exploratory CTAs unless discovery reopened
  if (effectiveStage === "closing") {
    const reopensDiscovery = /how (does|do|would)|what (is|are)|explain|tell me more|walk me through/i.test(latestInbound || "");
    if (!reopensDiscovery) {
      for (const s of ["quick_question", "permission_based"]) {
        if (!suppressedCta.includes(s)) suppressedCta.push(s);
      }
      reasons.push("closing→suppress_exploratory");
    } else {
      reasons.push("closing+discovery_reopened→allow_educational");
    }
  }

  // Rule 4: Expansion stage → suppress beginner/starter even if beginner language
  if (effectiveStage === "expansion") {
    for (const s of ["starter", "beginner", "training", "consultation"]) {
      if (!suppressedOffers.includes(s)) suppressedOffers.push(s);
    }
    reasons.push("expansion→suppress_beginner_paths");
  }

  // Rule 5: Urgency modifier
  if (urgency.is_urgent) {
    // Faster CTA, logistics emphasis
    if (finalCta === "soft_offer" || finalCta === "permission_based") {
      finalCta = "direct_offer";
    }
    for (const cat of ["shipping", "pickup", "local_support", "fulfillment"]) {
      if (!preferredOffers.includes(cat)) preferredOffers.push(cat);
    }
    // Suppress slow paths
    for (const s of ["nurture_asset", "newsletter", "future_planning"]) {
      if (!suppressedOffers.includes(s)) suppressedOffers.push(s);
    }
    if (!preferredKb.includes("knowledge")) preferredKb.unshift("knowledge");
    reasons.push("urgent→direct_cta+logistics");
  }

  // Rule 6: Merge decision-level offer preferences with stage policy
  // Decision recommended categories get boosted if not suppressed by stage
  for (const cat of decision.recommended_offer_categories) {
    if (!suppressedOffers.includes(cat) && !preferredOffers.includes(cat)) {
      preferredOffers.push(cat);
    }
  }
  // Decision suppressed categories merge with stage suppression
  for (const cat of decision.suppressed_offer_categories) {
    if (!suppressedOffers.includes(cat)) {
      suppressedOffers.push(cat);
    }
  }

  // Rule 7: Stage-aware CTA override — if decision CTA is suppressed by stage, use stage default
  if (suppressedCta.includes(finalCta)) {
    finalCta = preferredCta[0] || "soft_offer";
    reasons.push(`cta_override:${decision.cta_strategy}→${finalCta}`);
  }

  return {
    effective_stage: effectiveStage,
    final_response_style: policy.response_style,
    final_proof_style: policy.proof_style,
    final_cta_strategy: finalCta,
    final_preferred_cta_patterns: preferredCta,
    final_suppressed_cta_patterns: suppressedCta,
    final_preferred_offer_categories: preferredOffers,
    final_suppressed_offer_categories: suppressedOffers,
    final_preferred_kb_types: preferredKb,
    stage_reasoning: reasons.join("; "),
    urgency,
  };
}

// ── Format for prompt injection ───────────

export function formatStagePolicyBlock(resolved: ResolvedPolicy): string {
  const parts = [
    "=== STAGE-AWARE DECISION POLICY (internal — do NOT share with customer) ===",
    `Effective Deal Stage: ${resolved.effective_stage}`,
    `Stage Reasoning: ${resolved.stage_reasoning}`,
    "",
    `Response Style: ${resolved.final_response_style}`,
    `Proof Style: ${resolved.final_proof_style}`,
    `CTA Strategy: ${resolved.final_cta_strategy}`,
  ];

  if (resolved.urgency.is_urgent) {
    parts.push("");
    parts.push("⚡ URGENCY DETECTED: This prospect has an immediate need.");
    parts.push("- Use direct, action-oriented language");
    parts.push("- Emphasize speed, availability, and logistics");
    parts.push("- Do NOT suggest slow exploratory paths");
  }

  if (resolved.final_preferred_cta_patterns.length > 0) {
    parts.push(`Preferred CTA Patterns: ${resolved.final_preferred_cta_patterns.join(", ")}`);
  }
  if (resolved.final_suppressed_cta_patterns.length > 0) {
    parts.push(`Suppressed CTA Patterns: ${resolved.final_suppressed_cta_patterns.join(", ")}`);
  }
  if (resolved.final_preferred_offer_categories.length > 0) {
    parts.push(`Preferred Offer Types: ${resolved.final_preferred_offer_categories.join(", ")}`);
  }
  if (resolved.final_suppressed_offer_categories.length > 0) {
    parts.push(`Suppressed Offer Types: ${resolved.final_suppressed_offer_categories.join(", ")}`);
  }

  parts.push(
    "",
    "Instructions:",
    "- Follow the response style for this stage",
    "- Match proof selection to the proof style",
    "- Use the CTA strategy — do NOT use suppressed CTA patterns",
    "- Prefer offers from preferred types, avoid suppressed types",
    "- Follow escalation rules: if the conversation signals a stage shift, adapt accordingly",
    "- NEVER expose stage labels, policy names, or internal reasoning to the customer",
    "=== END STAGE-AWARE DECISION POLICY ===",
  );

  return parts.join("\n");
}

// ── Offer score adjustment by stage ───────

export function adjustOfferScoreByStage(
  baseScore: number,
  offerCategory: string,
  resolved: ResolvedPolicy,
): number {
  let adjusted = baseScore;
  const catLower = offerCategory.toLowerCase();

  // Boost if in preferred categories
  if (resolved.final_preferred_offer_categories.some(c =>
    catLower.includes(c.toLowerCase()) || c.toLowerCase().includes(catLower)
  )) {
    adjusted += 4;
  }

  // Penalize if in suppressed categories
  if (resolved.final_suppressed_offer_categories.some(c =>
    catLower.includes(c.toLowerCase()) || c.toLowerCase().includes(catLower)
  )) {
    adjusted -= 6;
  }

  // Urgency bonus for logistics/shipping offers
  if (resolved.urgency.is_urgent && /ship|pickup|local|fulfil|express|rush/i.test(catLower)) {
    adjusted += 5;
  }

  return adjusted;
}
