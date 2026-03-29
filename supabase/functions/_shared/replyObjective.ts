// ============================================
// REPLY OBJECTIVE ORCHESTRATOR
// Decides the ONE main job of each reply
// ============================================

import type { ClassifiedDecision, ObjectionClass } from "./intentClassifier.ts";
import type { ResolvedPolicy, DealStage, UrgencySignal } from "./stagePolicy.ts";

// ── Objective taxonomy ────────────────────

export const REPLY_OBJECTIVES = [
  "answer_direct_question",
  "resolve_objection",
  "provide_proof",
  "guide_to_offer",
  "move_to_meeting_or_call",
  "move_to_commercial_step",
  "support_internal_buy_in",
  "resolve_logistics",
  "close_for_commitment",
  "support_expansion_or_reorder",
  "low_pressure_hold_or_nurture",
] as const;

export type ReplyObjective = typeof REPLY_OBJECTIVES[number];

// ── Objective metadata ────────────────────

interface ObjectiveMeta {
  prompt_emphasis: string;
  preferred_cta: string[];
  suppressed_cta: string[];
  preferred_proof: string;
  preferred_offer_categories: string[];
  suppressed_offer_categories: string[];
  guardrails: string[];
}

const OBJECTIVE_META: Record<ReplyObjective, ObjectiveMeta> = {
  answer_direct_question: {
    prompt_emphasis: "Answer the prospect's specific question clearly and directly. Demonstrate competence. Do NOT pivot to a sales pitch before answering.",
    preferred_cta: ["soft_offer", "quick_question"],
    suppressed_cta: ["commitment", "close_now", "meeting_request"],
    preferred_proof: "Factual, product-specific evidence that directly answers the question",
    preferred_offer_categories: ["product_specific", "catalog", "demo"],
    suppressed_offer_categories: ["urgency", "limited_time"],
    guardrails: [
      "Answer the question FIRST before anything else",
      "Do NOT force an offer if the question does not warrant one",
      "A meeting CTA is only appropriate if the question genuinely requires a live walkthrough",
    ],
  },
  resolve_objection: {
    prompt_emphasis: "Acknowledge the concern empathetically, then provide specific evidence to address it. Do NOT dismiss or argue.",
    preferred_cta: ["proof_based", "soft_offer", "consultation"],
    suppressed_cta: ["commitment", "close_now", "direct_offer"],
    preferred_proof: "Proof directly addressing the specific objection — ROI for budget, success stories for quality, timelines for effort",
    preferred_offer_categories: ["sample", "trial", "case_study_asset", "roi_calculator"],
    suppressed_offer_categories: ["urgency", "limited_time", "discount"],
    guardrails: [
      "Focus on ONE objection — do not try to preemptively address others",
      "Do NOT pitch a product expansion while handling an objection",
      "If the objection is unresolvable now, offer to revisit rather than forcing",
    ],
  },
  provide_proof: {
    prompt_emphasis: "Lead with concrete evidence: case studies, data, testimonials, or third-party validation. Let proof do the selling.",
    preferred_cta: ["proof_based", "easy_forward", "soft_offer"],
    suppressed_cta: ["commitment", "close_now"],
    preferred_proof: "Strongest available case studies, specific metrics, customer testimonials matching their context",
    preferred_offer_categories: ["case_study_asset", "sample", "demo", "trial"],
    suppressed_offer_categories: ["discount", "urgency"],
    guardrails: [
      "Do not overwhelm with more than 2 proof points",
      "Make proof shareable if internal buy-in might be needed",
    ],
  },
  guide_to_offer: {
    prompt_emphasis: "Naturally guide the conversation toward the most relevant offer or product path. Be helpful, not pushy.",
    preferred_cta: ["direct_offer", "soft_offer", "demo"],
    suppressed_cta: ["breakup_close", "permission_based"],
    preferred_proof: "Proof that supports the specific offer being recommended",
    preferred_offer_categories: ["product_specific", "starter", "demo", "financing"],
    suppressed_offer_categories: ["nurture_asset", "newsletter"],
    guardrails: [
      "Only guide to ONE offer — do not present a catalog",
      "The offer must be relevant to the prospect's stated need",
    ],
  },
  move_to_meeting_or_call: {
    prompt_emphasis: "The conversation has progressed enough to warrant a live conversation. Suggest a meeting/call naturally.",
    preferred_cta: ["meeting_request", "direct_offer"],
    suppressed_cta: ["breakup_close", "quick_question"],
    preferred_proof: "Brief supporting evidence that justifies why a meeting would be valuable",
    preferred_offer_categories: ["consultation", "demo"],
    suppressed_offer_categories: ["newsletter", "nurture_asset"],
    guardrails: [
      "Do NOT ask for a meeting if the prospect just asked a simple factual question",
      "Provide a clear reason why a meeting would benefit THEM",
    ],
  },
  move_to_commercial_step: {
    prompt_emphasis: "Advance the deal to a concrete commercial next step: pricing discussion, proposal, or trial setup.",
    preferred_cta: ["direct_offer", "timing_check", "meeting_request"],
    suppressed_cta: ["permission_based", "quick_question", "breakup_close"],
    preferred_proof: "ROI data, pricing context, competitive positioning",
    preferred_offer_categories: ["product_specific", "financing", "volume_pricing", "roi_calculator"],
    suppressed_offer_categories: ["beginner", "starter", "nurture_asset"],
    guardrails: [
      "Only push commercial steps when the prospect has shown buying signals",
      "Do NOT force pricing discussion if the prospect is still evaluating",
    ],
  },
  support_internal_buy_in: {
    prompt_emphasis: "Provide concise, easy-to-forward content that helps the prospect sell internally. Executive summaries, one-pagers, ROI snapshots.",
    preferred_cta: ["easy_forward", "proof_based", "soft_offer"],
    suppressed_cta: ["commitment", "close_now", "meeting_request"],
    preferred_proof: "Executive-ready summaries, one-pagers, ROI snapshots, comparison guides",
    preferred_offer_categories: ["summary_asset", "one_pager", "roi_summary", "executive_brief"],
    suppressed_offer_categories: ["discount", "urgency", "starter"],
    guardrails: [
      "Keep content concise and forward-ready",
      "Do NOT ask for a meeting with the decision-maker directly — let the champion manage that",
    ],
  },
  resolve_logistics: {
    prompt_emphasis: "Address logistics questions directly: shipping, delivery, fulfillment, availability, timing. Be concrete and specific.",
    preferred_cta: ["direct_answer", "direct_offer", "soft_offer"],
    suppressed_cta: ["permission_based", "breakup_close"],
    preferred_proof: "Specific logistics capabilities, availability data, fulfillment options",
    preferred_offer_categories: ["shipping", "pickup", "local_support", "fulfillment", "express"],
    suppressed_offer_categories: ["nurture_asset", "newsletter", "training"],
    guardrails: [
      "Answer logistics questions with CONCRETE specifics — not vague reassurances",
      "If you do not have the answer, say so and offer to find out",
    ],
  },
  close_for_commitment: {
    prompt_emphasis: "The deal is ready to close. Guide toward commitment: confirm order, sign agreement, or finalize terms. Remove friction.",
    preferred_cta: ["commitment", "direct_offer"],
    suppressed_cta: ["quick_question", "permission_based", "soft_offer", "breakup_close"],
    preferred_proof: "Final reassurance only if needed — do not introduce new evidence at this stage",
    preferred_offer_categories: ["implementation_support", "product_specific"],
    suppressed_offer_categories: ["starter", "beginner", "trial", "newsletter", "nurture_asset"],
    guardrails: [
      "Do NOT introduce new topics or discovery questions",
      "Keep it short and action-oriented",
      "If the prospect raises a new concern, address it briefly then steer back to commitment",
    ],
  },
  support_expansion_or_reorder: {
    prompt_emphasis: "Treat as an existing relationship. Focus on growth: new products, volume upgrades, loyalty benefits.",
    preferred_cta: ["direct_offer", "soft_offer"],
    suppressed_cta: ["permission_based", "breakup_close", "quick_question"],
    preferred_proof: "Scaling success stories, volume benefits, new product introductions",
    preferred_offer_categories: ["bulk", "rewards", "repeat_order", "volume_pricing", "product_specific"],
    suppressed_offer_categories: ["starter", "beginner", "trial", "consultation", "training"],
    guardrails: [
      "Do NOT treat as a new prospect",
      "Even if they use beginner-like language, respond at their account level",
    ],
  },
  low_pressure_hold_or_nurture: {
    prompt_emphasis: "Keep the relationship warm without pressure. Share value, be helpful, plant seeds for future engagement.",
    preferred_cta: ["soft_offer", "timing_check", "quick_question"],
    suppressed_cta: ["commitment", "close_now", "direct_offer"],
    preferred_proof: "Industry insights, helpful resources, light educational content",
    preferred_offer_categories: ["nurture_asset", "newsletter", "future_planning"],
    suppressed_offer_categories: ["urgency", "limited_time", "discount"],
    guardrails: [
      "Do NOT push for a meeting or commitment",
      "If prospect shows renewed interest, escalate to appropriate objective in the next reply",
    ],
  },
};

// ── Inbound signal detection ──────────────

interface InboundSignals {
  has_direct_question: boolean;
  has_proof_request: boolean;
  has_internal_buyin_signal: boolean;
  has_logistics_question: boolean;
  has_pricing_mention: boolean;
  has_commitment_signal: boolean;
  has_reorder_signal: boolean;
  has_timing_delay: boolean;
}

function detectInboundSignals(text: string): InboundSignals {
  if (!text) return {
    has_direct_question: false, has_proof_request: false, has_internal_buyin_signal: false,
    has_logistics_question: false, has_pricing_mention: false, has_commitment_signal: false,
    has_reorder_signal: false, has_timing_delay: false,
  };
  const t = text.toLowerCase();
  return {
    has_direct_question: /\?\s*$|\?["\s]|how (do|does|can|would)|what (is|are)|where (can|do)|when (can|do|will)|can you (explain|tell|clarify|send)/im.test(text),
    has_proof_request: /case stud|success stor|reference|testimonial|example|proof|show me|who else|other (companies|clients|customers)|results?\b/i.test(t),
    has_internal_buyin_signal: /(?:my |the )?(?:boss|manager|team|board|cfo|ceo|director|vp)|approv|sign.?off|buy.?in|stakeholder|share (this|it) with|forward.*to|need to (?:discuss|check|run it by)/i.test(t),
    has_logistics_question: /ship(?:ping|ment)?|deliver|freight|pickup|local|warehouse|fulfil|lead time|turnaround|in stock|when.*arrive|how long.*take/i.test(t),
    has_pricing_mention: /pric(?:e|ing)|cost|budget|afford|invest(?:ment)?|roi\b|financ|payment|quote|proposal|offer.*price/i.test(t),
    has_commitment_signal: /ready to (?:go|order|buy|proceed|start)|let'?s (do it|go|move forward|proceed)|sign.*(?:up|contract)|place.*order|confirm|finalize|how do (?:I|we) (?:order|buy|start|sign)/i.test(t),
    has_reorder_signal: /re.?order|repeat|again|another (?:batch|order|round)|bulk|more of the same|same as (?:last|before)|replenish/i.test(t),
    has_timing_delay: /not (?:now|yet|ready)|later|next (?:quarter|year|month)|timing|circle back|revisit|maybe (?:later|next)/i.test(t),
  };
}

// ── Objective selection ───────────────────

export interface ReplyObjectiveResult {
  primary: ReplyObjective;
  secondary: ReplyObjective | null;
  reasoning: string;
  confidence: "high" | "medium" | "low";
  override_source: string | null; // "inbound_question", "inbound_proof_request", etc.
  meta: ObjectiveMeta;
  secondary_meta: ObjectiveMeta | null;
}

export function selectReplyObjective(
  latestInbound: string,
  decision: ClassifiedDecision,
  stagePolicy: ResolvedPolicy,
  recentCtaTypes?: string[],
  task?: string,
): ReplyObjectiveResult {
  const signals = detectInboundSignals(latestInbound);
  const objections = decision.detected_objection_classes;
  const intent = decision.detected_commercial_intent;
  const stage = stagePolicy.effective_stage;
  const urgency = stagePolicy.urgency;
  const reasons: string[] = [];
  let override: string | null = null;

  // ── Precedence-ordered selection ────────

  // P0: Commitment signal — highest priority
  if (signals.has_commitment_signal && stage !== "engaged") {
    const primary: ReplyObjective = "close_for_commitment";
    const secondary = signals.has_logistics_question ? "resolve_logistics" as ReplyObjective : null;
    reasons.push("commitment_signal_detected");
    return build(primary, secondary, reasons, "high", null);
  }

  // P1: Direct question from prospect — overrides stage posture
  if (signals.has_direct_question) {
    override = "inbound_question";
    
    // Sub-classify the question type
    if (signals.has_logistics_question) {
      reasons.push("direct_logistics_question");
      const secondary = urgency.is_urgent ? "guide_to_offer" as ReplyObjective : null;
      return build("resolve_logistics", secondary, reasons, "high", override);
    }
    if (signals.has_pricing_mention) {
      reasons.push("direct_pricing_question");
      return build("move_to_commercial_step", null, reasons, "high", override);
    }
    if (signals.has_proof_request) {
      reasons.push("direct_proof_request");
      return build("provide_proof", null, reasons, "high", override);
    }
    if (signals.has_internal_buyin_signal) {
      reasons.push("internal_buyin_request");
      return build("support_internal_buy_in", null, reasons, "high", override);
    }
    
    // Generic direct question — answer it, but secondary can be stage-appropriate
    reasons.push("direct_question→answer_first");
    const secondary = getStageDefaultObjective(stage);
    return build("answer_direct_question", secondary !== "answer_direct_question" ? secondary : null, reasons, "high", override);
  }

  // P2: Proof request (non-question form, e.g., "Can you share some case studies")
  if (signals.has_proof_request) {
    override = "inbound_proof_request";
    reasons.push("proof_request_detected");
    const secondary = signals.has_internal_buyin_signal ? "support_internal_buy_in" as ReplyObjective : null;
    return build("provide_proof", secondary, reasons, "high", override);
  }

  // P3: Internal buy-in signal
  if (signals.has_internal_buyin_signal) {
    override = "inbound_buyin_signal";
    reasons.push("internal_buyin_signal");
    return build("support_internal_buy_in", null, reasons, "high", override);
  }

  // P4: Hard objection — must address before commercial push
  if (objections.length > 0 && decision.confidence !== "low") {
    const primaryObjection = objections[0];
    
    // Budget/quality/implementation are hard objections
    if (["budget", "quality_concern", "implementation_effort", "comparison_alternative"].includes(primaryObjection)) {
      reasons.push(`hard_objection:${primaryObjection}`);
      const secondary = stage === "closing" ? "close_for_commitment" as ReplyObjective : null;
      return build("resolve_objection", secondary, reasons, "medium", null);
    }
  }

  // P5: Urgency + logistics
  if (urgency.is_urgent && signals.has_logistics_question) {
    reasons.push("urgent+logistics");
    return build("resolve_logistics", "guide_to_offer", reasons, "high", "urgency_override");
  }
  if (urgency.is_urgent) {
    reasons.push("urgent→direct_action");
    const objective = stage === "closing" || stage === "commercial" ? "close_for_commitment" as ReplyObjective : "guide_to_offer" as ReplyObjective;
    return build(objective, "resolve_logistics", reasons, "medium", "urgency_override");
  }

  // P6: Reorder/expansion signal
  if (signals.has_reorder_signal || stage === "expansion") {
    reasons.push("expansion_or_reorder");
    return build("support_expansion_or_reorder", null, reasons, "medium", null);
  }

  // P7: Timing delay — low pressure
  if (signals.has_timing_delay && !signals.has_commitment_signal) {
    reasons.push("timing_delay→nurture");
    return build("low_pressure_hold_or_nurture", null, reasons, "medium", null);
  }

  // P8: Soft objection handling
  if (objections.length > 0) {
    reasons.push(`soft_objection:${objections[0]}`);
    const secondary = getStageDefaultObjective(stage);
    return build("resolve_objection", secondary !== "resolve_objection" ? secondary : null, reasons, "medium", null);
  }

  // P9: Stage-driven default
  reasons.push(`stage_default:${stage}`);
  const primary = getStageDefaultObjective(stage);
  return build(primary, null, reasons, "low", null);
}

// ── Stage default objectives ──────────────

function getStageDefaultObjective(stage: DealStage): ReplyObjective {
  switch (stage) {
    case "engaged": return "answer_direct_question";
    case "active_eval": return "guide_to_offer";
    case "objection": return "resolve_objection";
    case "commercial": return "move_to_commercial_step";
    case "closing": return "close_for_commitment";
    case "expansion": return "support_expansion_or_reorder";
    default: return "answer_direct_question";
  }
}

// ── Builder ───────────────────────────────

function build(
  primary: ReplyObjective,
  secondary: ReplyObjective | null,
  reasons: string[],
  confidence: "high" | "medium" | "low",
  override: string | null,
): ReplyObjectiveResult {
  return {
    primary,
    secondary,
    reasoning: reasons.join("; "),
    confidence,
    override_source: override,
    meta: OBJECTIVE_META[primary],
    secondary_meta: secondary ? OBJECTIVE_META[secondary] : null,
  };
}

// ── Format for prompt injection ───────────

export function formatObjectiveBlock(result: ReplyObjectiveResult): string {
  const parts = [
    "=== REPLY OBJECTIVE (internal — do NOT share with customer) ===",
    `Primary Objective: ${result.primary.replace(/_/g, " ")}`,
  ];

  if (result.secondary) {
    parts.push(`Secondary Objective (light touch only): ${result.secondary.replace(/_/g, " ")}`);
  }

  parts.push(
    `Confidence: ${result.confidence}`,
    `Reasoning: ${result.reasoning}`,
    "",
    `📌 FOCUS: ${result.meta.prompt_emphasis}`,
    "",
    `Proof approach: ${result.meta.preferred_proof}`,
    `Preferred CTA: ${result.meta.preferred_cta.join(", ")}`,
    `Suppressed CTA: ${result.meta.suppressed_cta.join(", ")}`,
  );

  if (result.secondary && result.secondary_meta) {
    parts.push(
      "",
      `Secondary focus (brief): ${result.secondary_meta.prompt_emphasis}`,
    );
  }

  // Guardrails
  parts.push("", "Guardrails:");
  for (const g of result.meta.guardrails) {
    parts.push(`- ${g}`);
  }

  // Universal guardrails
  parts.push(
    "",
    "Universal reply rules:",
    "- This reply has ONE primary job. Execute it well.",
    "- Do NOT try to answer questions, handle objections, pitch offers, AND ask for a meeting all at once.",
    "- Secondary objective should take at most 1-2 sentences if included.",
    "- If primary is answer/resolve, do that BEFORE any commercial suggestion.",
    "- NEVER expose objective labels or orchestration reasoning to the customer.",
  );

  parts.push("=== END REPLY OBJECTIVE ===");
  return parts.join("\n");
}

// ── Apply objective to override CTA/offer decisions ──

export function applyObjectiveOverrides(
  result: ReplyObjectiveResult,
  currentCtaStrategy: string,
  currentPreferredOffers: string[],
  currentSuppressedOffers: string[],
): {
  final_cta: string;
  final_preferred_offers: string[];
  final_suppressed_offers: string[];
} {
  // Objective CTA takes priority if current CTA is in suppressed list
  let finalCta = currentCtaStrategy;
  if (result.meta.suppressed_cta.includes(currentCtaStrategy)) {
    finalCta = result.meta.preferred_cta[0] || currentCtaStrategy;
  }

  // Merge offer categories
  const preferredSet = new Set(currentPreferredOffers);
  for (const cat of result.meta.preferred_offer_categories) {
    preferredSet.add(cat);
  }
  
  const suppressedSet = new Set(currentSuppressedOffers);
  for (const cat of result.meta.suppressed_offer_categories) {
    suppressedSet.add(cat);
  }

  // Remove any overlap (preferred wins for objective-specific categories)
  for (const cat of result.meta.preferred_offer_categories) {
    suppressedSet.delete(cat);
  }

  return {
    final_cta: finalCta,
    final_preferred_offers: [...preferredSet],
    final_suppressed_offers: [...suppressedSet],
  };
}
