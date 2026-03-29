// ============================================
// OBJECTION + COMMERCIAL INTENT CLASSIFIER
// Lightweight deterministic + LLM-fallback layer
// for last-mile sales decision context
// ============================================

// ── Taxonomy ───────────────────────────────

export const OBJECTION_CLASSES = [
  "budget",
  "beginner_uncertainty",
  "quality_concern",
  "implementation_effort",
  "need_for_proof",
  "comparison_alternative",
  "timing_not_now",
  "logistics_shipping",
  "internal_buy_in",
  "scaling_bulk",
  "direct_product_interest",
  "training_onboarding",
] as const;

export type ObjectionClass = typeof OBJECTION_CLASSES[number];

export const COMMERCIAL_INTENTS = [
  "ready_to_buy",
  "exploring_options",
  "seeking_reassurance",
  "price_sensitive",
  "needs_internal_approval",
  "evaluating_alternatives",
  "requesting_proof",
  "logistical_inquiry",
  "scaling_inquiry",
  "training_inquiry",
  "general_interest",
] as const;

export type CommercialIntent = typeof COMMERCIAL_INTENTS[number];

// ── Strategy mappings ──────────────────────

export interface DecisionStrategy {
  response_strategy: string;
  proof_strategy: string;
  cta_strategy: string;
  recommended_offer_categories: string[];
  suppressed_offer_categories: string[];
  kb_boost_types: string[];
}

const STRATEGY_MAP: Record<ObjectionClass, DecisionStrategy> = {
  budget: {
    response_strategy: "Acknowledge cost concern, lead with ROI and entry-level paths",
    proof_strategy: "ROI case studies, cost-comparison data, financing success stories",
    cta_strategy: "soft_offer",
    recommended_offer_categories: ["financing", "entry_level", "roi_calculator", "starter"],
    suppressed_offer_categories: ["premium", "enterprise", "bulk"],
    kb_boost_types: ["case_study", "objection"],
  },
  beginner_uncertainty: {
    response_strategy: "Reassure with simplicity, offer guided onboarding path",
    proof_strategy: "Beginner success stories, simplicity proof, onboarding walkthroughs",
    cta_strategy: "consultation",
    recommended_offer_categories: ["starter", "training", "consultation", "beginner"],
    suppressed_offer_categories: ["advanced", "enterprise", "bulk"],
    kb_boost_types: ["case_study", "knowledge"],
  },
  quality_concern: {
    response_strategy: "Lead with proof, samples, and third-party validation",
    proof_strategy: "Quality certifications, sample programs, customer testimonials",
    cta_strategy: "proof_based",
    recommended_offer_categories: ["sample", "trial", "quality_proof", "certification"],
    suppressed_offer_categories: ["discount", "financing"],
    kb_boost_types: ["case_study", "objection", "knowledge"],
  },
  implementation_effort: {
    response_strategy: "Minimize perceived effort, offer implementation support",
    proof_strategy: "Implementation timelines, support packages, turnkey solutions",
    cta_strategy: "soft_offer",
    recommended_offer_categories: ["implementation_support", "turnkey", "consultation"],
    suppressed_offer_categories: ["diy", "self_serve"],
    kb_boost_types: ["case_study", "knowledge"],
  },
  need_for_proof: {
    response_strategy: "Provide concrete evidence before any commercial push",
    proof_strategy: "Case studies, testimonials, data points, third-party validation",
    cta_strategy: "proof_based",
    recommended_offer_categories: ["sample", "trial", "case_study_asset", "demo"],
    suppressed_offer_categories: ["discount", "urgency"],
    kb_boost_types: ["case_study", "objection"],
  },
  comparison_alternative: {
    response_strategy: "Non-defensive differentiation, acknowledge alternatives",
    proof_strategy: "Competitive differentiators, switching success stories",
    cta_strategy: "soft_offer",
    recommended_offer_categories: ["comparison_guide", "switching", "trial"],
    suppressed_offer_categories: ["discount", "urgency"],
    kb_boost_types: ["competitor", "case_study", "objection"],
  },
  timing_not_now: {
    response_strategy: "Low-pressure, plant seeds for future, offer value now",
    proof_strategy: "Industry trends, future-oriented insights",
    cta_strategy: "timing_check",
    recommended_offer_categories: ["nurture_asset", "newsletter", "future_planning"],
    suppressed_offer_categories: ["urgency", "discount", "limited_time"],
    kb_boost_types: ["knowledge", "messaging"],
  },
  logistics_shipping: {
    response_strategy: "Address logistics directly with concrete options",
    proof_strategy: "Shipping/fulfillment capabilities, local support proof",
    cta_strategy: "direct_answer",
    recommended_offer_categories: ["shipping", "pickup", "local_support", "fulfillment"],
    suppressed_offer_categories: [],
    kb_boost_types: ["knowledge"],
  },
  internal_buy_in: {
    response_strategy: "Provide easy-to-forward summary assets and concise proof",
    proof_strategy: "Executive summary, one-pager, ROI snapshot",
    cta_strategy: "easy_forward",
    recommended_offer_categories: ["summary_asset", "one_pager", "roi_summary", "executive_brief"],
    suppressed_offer_categories: ["discount", "urgency"],
    kb_boost_types: ["case_study", "knowledge"],
  },
  scaling_bulk: {
    response_strategy: "Highlight volume benefits, loyalty programs, dedicated support",
    proof_strategy: "Scaling success stories, volume pricing proof",
    cta_strategy: "soft_offer",
    recommended_offer_categories: ["bulk", "rewards", "repeat_order", "volume_pricing", "dedicated_support"],
    suppressed_offer_categories: ["starter", "beginner", "trial"],
    kb_boost_types: ["case_study", "knowledge"],
  },
  direct_product_interest: {
    response_strategy: "Match interest to specific product path, be direct",
    proof_strategy: "Product-specific case studies, specs, comparisons",
    cta_strategy: "direct_offer",
    recommended_offer_categories: ["product_specific", "demo", "sample", "catalog"],
    suppressed_offer_categories: [],
    kb_boost_types: ["knowledge", "case_study"],
  },
  training_onboarding: {
    response_strategy: "Offer structured learning path and support resources",
    proof_strategy: "Training success stories, curriculum overviews",
    cta_strategy: "consultation",
    recommended_offer_categories: ["training", "onboarding", "workshop", "consultation", "certification"],
    suppressed_offer_categories: ["discount", "urgency"],
    kb_boost_types: ["knowledge", "case_study"],
  },
};

// ── Pattern-based detection (deterministic) ─

interface PatternRule {
  objection: ObjectionClass;
  patterns: RegExp[];
  weight: number;
}

const PATTERN_RULES: PatternRule[] = [
  {
    objection: "budget",
    patterns: [
      /budget|pric(?:e|ing)|cost|afford|expensive|cheap|invest(?:ment)?|roi\b|return on|financ/i,
      /too much|out of.*range|money|payment plan|lease|installment/i,
    ],
    weight: 1,
  },
  {
    objection: "beginner_uncertainty",
    patterns: [
      /never (?:done|tried|used)|new to|beginner|first time|getting started|no experience|don'?t know (?:where|how)|overwhelm/i,
      /is it (?:hard|difficult|complicated)|learn(?:ing)? curve|hand.?hold/i,
    ],
    weight: 1,
  },
  {
    objection: "quality_concern",
    patterns: [
      /quality|durabilit|reliable|last (?:long|how)|warranty|guarantee|defect|return polic/i,
      /worth it|reviews?|testimonial|proof|evidence|trust/i,
    ],
    weight: 1,
  },
  {
    objection: "implementation_effort",
    patterns: [
      /implement|set ?up|install|integrat|migration|onboard|how long (?:does|will)|effort|resource|bandwidth/i,
      /complicated|complex|heavy lift|disruption|downtime/i,
    ],
    weight: 1,
  },
  {
    objection: "need_for_proof",
    patterns: [
      /case stud|success stor|reference|testimonial|can you show|example|proof|demo|pilot|trial/i,
      /who else|other (?:companies|clients|customers)|results?\b/i,
    ],
    weight: 1,
  },
  {
    objection: "comparison_alternative",
    patterns: [
      /compet|alternative|vs\b|compared|switch|other (?:option|vendor|provider|solution)|currently using|already (?:have|use)/i,
      /why (?:you|your)|different from|better than|advantage over/i,
    ],
    weight: 1,
  },
  {
    objection: "timing_not_now",
    patterns: [
      /not (?:now|yet|ready)|later|next (?:quarter|year|month)|timing|busy|priorities|backburner|revisit/i,
      /circle back|touch base later|check (?:back|in) (?:later|next)|maybe (?:later|next)/i,
    ],
    weight: 1,
  },
  {
    objection: "logistics_shipping",
    patterns: [
      /ship(?:ping|ment)?|deliver|freight|pickup|local|warehouse|fulfil|lead time|turnaround|in stock/i,
      /where (?:are you|do you ship)|can I pick up|nearby|location/i,
    ],
    weight: 1,
  },
  {
    objection: "internal_buy_in",
    patterns: [
      /(?:my |the )?(?:boss|manager|team|board|cfo|ceo|director|vp)|approv|sign.?off|buy.?in|stakeholder|decision.?maker/i,
      /need to (?:discuss|check|run it by|get approval)|internal|committee/i,
    ],
    weight: 1,
  },
  {
    objection: "scaling_bulk",
    patterns: [
      /bulk|volume|scale|repeat|reorder|wholesale|large (?:order|quantity)|ongoing|regular order|loyalty|reward/i,
      /discount for (?:volume|bulk|large)|grow(?:ing|th)|expand/i,
    ],
    weight: 1,
  },
  {
    objection: "direct_product_interest",
    patterns: [
      /interested in|looking (?:for|at)|want to (?:buy|order|get)|specific (?:product|item|model)|which (?:one|model)/i,
      /do you (?:have|carry|sell|offer)|catalog|product (?:line|range)|available/i,
    ],
    weight: 1,
  },
  {
    objection: "training_onboarding",
    patterns: [
      /train(?:ing)?|learn|workshop|course|certif|onboard|tutorial|how.?to|education|skill/i,
      /support (?:after|during)|ongoing support|help (?:getting|us) started/i,
    ],
    weight: 1,
  },
];

// ── Detect from text ───────────────────────

interface DetectionHit {
  objection: ObjectionClass;
  confidence: number; // 0-1
  source: "pattern" | "context" | "intelligence";
}

function detectFromText(text: string): DetectionHit[] {
  if (!text || text.length < 10) return [];
  const lower = text.toLowerCase();
  const hits: DetectionHit[] = [];

  for (const rule of PATTERN_RULES) {
    let matchCount = 0;
    for (const pattern of rule.patterns) {
      if (pattern.test(lower)) matchCount++;
    }
    if (matchCount > 0) {
      // confidence based on how many pattern groups matched
      const confidence = matchCount >= 2 ? 0.9 : 0.65;
      hits.push({ objection: rule.objection, confidence, source: "pattern" });
    }
  }

  return hits;
}

function detectFromIntelligence(
  intelligenceJson: Record<string, unknown> | null,
  tags?: string[],
  segment?: string,
): DetectionHit[] {
  const hits: DetectionHit[] = [];
  if (!intelligenceJson) return hits;

  // Check objections_json from lead_intelligence
  const objections = (intelligenceJson as any).objections_json;
  if (Array.isArray(objections)) {
    for (const obj of objections) {
      const text = typeof obj === "string" ? obj : (obj?.text || obj?.description || "");
      if (!text) continue;
      const subHits = detectFromText(text);
      for (const h of subHits) {
        h.source = "intelligence";
        h.confidence = Math.min(h.confidence + 0.1, 0.95);
        hits.push(h);
      }
    }
  }

  // Check buying_signals_json for direct interest
  const buyingSignals = (intelligenceJson as any).buying_signals_json;
  if (Array.isArray(buyingSignals)) {
    for (const sig of buyingSignals) {
      const text = typeof sig === "string" ? sig : (sig?.description || "");
      if (/pricing|budget|cost/i.test(text)) {
        hits.push({ objection: "budget", confidence: 0.6, source: "intelligence" });
      }
      if (/product|specific|interested/i.test(text)) {
        hits.push({ objection: "direct_product_interest", confidence: 0.55, source: "intelligence" });
      }
    }
  }

  // Tag-based detection
  if (tags && tags.length > 0) {
    const tagMap: Record<string, ObjectionClass> = {
      budget: "budget", beginner: "beginner_uncertainty", training: "training_onboarding",
      financing: "budget", urgent: "timing_not_now", scaling: "scaling_bulk",
      bulk: "scaling_bulk", local_support: "logistics_shipping", outsourcing: "implementation_effort",
      rewards: "scaling_bulk", drinkware: "direct_product_interest",
    };
    for (const tag of tags) {
      const mapped = tagMap[tag.toLowerCase()];
      if (mapped) {
        hits.push({ objection: mapped, confidence: 0.5, source: "context" });
      }
    }
  }

  return hits;
}

// ── Commercial intent derivation ───────────

function deriveCommercialIntent(objections: ObjectionClass[], stage?: string): CommercialIntent {
  if (objections.length === 0) return "general_interest";

  // Priority-based mapping
  if (objections.includes("direct_product_interest")) {
    if (stage === "negotiation" || stage === "post_meeting") return "ready_to_buy";
    return "exploring_options";
  }
  if (objections.includes("budget")) return "price_sensitive";
  if (objections.includes("comparison_alternative")) return "evaluating_alternatives";
  if (objections.includes("internal_buy_in")) return "needs_internal_approval";
  if (objections.includes("need_for_proof") || objections.includes("quality_concern")) return "requesting_proof";
  if (objections.includes("scaling_bulk")) return "scaling_inquiry";
  if (objections.includes("logistics_shipping")) return "logistical_inquiry";
  if (objections.includes("training_onboarding")) return "training_inquiry";
  if (objections.includes("beginner_uncertainty")) return "seeking_reassurance";
  if (objections.includes("timing_not_now")) return "exploring_options";
  if (objections.includes("implementation_effort")) return "seeking_reassurance";

  return "general_interest";
}

// ── Main classifier ────────────────────────

export interface ClassifiedDecision {
  detected_objection_classes: ObjectionClass[];
  detected_commercial_intent: CommercialIntent;
  response_strategy: string;
  proof_strategy: string;
  cta_strategy: string;
  recommended_offer_categories: string[];
  suppressed_offer_categories: string[];
  kb_boost_types: string[];
  confidence: "high" | "medium" | "low";
}

export function classifyCommercialIntent(
  latestInbound: string,
  threadContext?: string,
  intelligenceJson?: Record<string, unknown> | null,
  stage?: string,
  tags?: string[],
  segment?: string,
): ClassifiedDecision {
  // 1. Detect from latest inbound (highest priority)
  const inboundHits = detectFromText(latestInbound);

  // 2. Detect from thread context (lower weight)
  const threadHits = threadContext
    ? detectFromText(threadContext).map(h => ({ ...h, confidence: h.confidence * 0.6 }))
    : [];

  // 3. Detect from intelligence/tags
  const intelHits = detectFromIntelligence(intelligenceJson || null, tags, segment);

  // 4. Merge and deduplicate — keep highest confidence per class
  const allHits = [...inboundHits, ...threadHits, ...intelHits];
  const bestPerClass = new Map<ObjectionClass, DetectionHit>();
  for (const hit of allHits) {
    const existing = bestPerClass.get(hit.objection);
    if (!existing || hit.confidence > existing.confidence) {
      bestPerClass.set(hit.objection, hit);
    }
  }

  // 5. Filter to meaningful detections (confidence > 0.4)
  const detected = Array.from(bestPerClass.entries())
    .filter(([, hit]) => hit.confidence > 0.4)
    .sort((a, b) => b[1].confidence - a[1].confidence);

  const detectedClasses = detected.map(([cls]) => cls);

  // 6. Build merged strategy from top 2 objection classes
  const topClasses = detectedClasses.slice(0, 2);
  const mergedStrategy: DecisionStrategy = {
    response_strategy: "",
    proof_strategy: "",
    cta_strategy: "soft_offer",
    recommended_offer_categories: [],
    suppressed_offer_categories: [],
    kb_boost_types: [],
  };

  const responseStrategies: string[] = [];
  const proofStrategies: string[] = [];
  const seenCategories = new Set<string>();
  const seenSuppressed = new Set<string>();
  const seenKbTypes = new Set<string>();

  for (const cls of topClasses) {
    const strategy = STRATEGY_MAP[cls];
    if (!strategy) continue;
    responseStrategies.push(strategy.response_strategy);
    proofStrategies.push(strategy.proof_strategy);
    mergedStrategy.cta_strategy = strategy.cta_strategy; // last wins (highest-priority class)
    for (const cat of strategy.recommended_offer_categories) {
      if (!seenCategories.has(cat)) { seenCategories.add(cat); mergedStrategy.recommended_offer_categories.push(cat); }
    }
    for (const cat of strategy.suppressed_offer_categories) {
      if (!seenSuppressed.has(cat)) { seenSuppressed.add(cat); mergedStrategy.suppressed_offer_categories.push(cat); }
    }
    for (const t of strategy.kb_boost_types) {
      if (!seenKbTypes.has(t)) { seenKbTypes.add(t); mergedStrategy.kb_boost_types.push(t); }
    }
  }

  // Use first class CTA strategy (highest confidence)
  if (topClasses.length > 0) {
    mergedStrategy.cta_strategy = STRATEGY_MAP[topClasses[0]]?.cta_strategy || "soft_offer";
  }

  mergedStrategy.response_strategy = responseStrategies.join("; ");
  mergedStrategy.proof_strategy = proofStrategies.join("; ");

  // 7. Derive commercial intent
  const commercialIntent = deriveCommercialIntent(detectedClasses, stage);

  // 8. Determine confidence level
  const maxConfidence = detected.length > 0 ? detected[0][1].confidence : 0;
  const confidence: "high" | "medium" | "low" =
    maxConfidence >= 0.8 ? "high" : maxConfidence >= 0.55 ? "medium" : "low";

  return {
    detected_objection_classes: detectedClasses,
    detected_commercial_intent: commercialIntent,
    response_strategy: mergedStrategy.response_strategy || "General engagement — respond helpfully and advance conversation",
    proof_strategy: mergedStrategy.proof_strategy || "Use available case studies and knowledge base",
    cta_strategy: mergedStrategy.cta_strategy,
    recommended_offer_categories: mergedStrategy.recommended_offer_categories,
    suppressed_offer_categories: mergedStrategy.suppressed_offer_categories,
    kb_boost_types: mergedStrategy.kb_boost_types,
    confidence,
  };
}

// ── Format for prompt injection ────────────

export function formatDecisionBlock(decision: ClassifiedDecision): string {
  if (decision.detected_objection_classes.length === 0 && decision.confidence === "low") {
    return ""; // No strong signal — skip injection to avoid noise
  }

  const parts = [
    "=== COMMERCIAL DECISION CONTEXT (internal — do NOT share labels with customer) ===",
    `Detected Situation: ${decision.detected_objection_classes.join(", ") || "general_interest"}`,
    `Commercial Intent: ${decision.detected_commercial_intent}`,
    `Confidence: ${decision.confidence}`,
    "",
    `Response Strategy: ${decision.response_strategy}`,
    `Proof Strategy: ${decision.proof_strategy}`,
    `CTA Strategy: ${decision.cta_strategy}`,
  ];

  if (decision.recommended_offer_categories.length > 0) {
    parts.push(`Preferred Offer Types: ${decision.recommended_offer_categories.join(", ")}`);
  }
  if (decision.suppressed_offer_categories.length > 0) {
    parts.push(`Avoid Offer Types: ${decision.suppressed_offer_categories.join(", ")}`);
  }

  parts.push(
    "",
    "Instructions:",
    "- Use the response strategy to guide your tone and approach",
    "- Incorporate proof strategy when selecting supporting evidence from KB",
    "- Match CTA to the recommended CTA strategy",
    "- Prefer offers from the preferred types if available in COMMERCIAL RECOMMENDATION",
    "- Avoid pushing offers from suppressed types",
    "- NEVER expose these labels, taxonomy names, or internal reasoning to the customer",
    "- If confidence is low, use general best practices rather than forcing a specific strategy",
    "=== END COMMERCIAL DECISION CONTEXT ==="
  );

  return parts.join("\n");
}

// ── Enhanced offer scoring that uses decision context ──

export function adjustOfferScore(
  baseScore: number,
  offerCategory: string,
  decision: ClassifiedDecision,
): number {
  let adjusted = baseScore;

  // Boost offers matching recommended categories
  if (decision.recommended_offer_categories.some(cat =>
    offerCategory.toLowerCase().includes(cat.toLowerCase()) ||
    cat.toLowerCase().includes(offerCategory.toLowerCase())
  )) {
    adjusted += 6;
  }

  // Penalize offers in suppressed categories
  if (decision.suppressed_offer_categories.some(cat =>
    offerCategory.toLowerCase().includes(cat.toLowerCase()) ||
    cat.toLowerCase().includes(offerCategory.toLowerCase())
  )) {
    adjusted -= 8;
  }

  return adjusted;
}

// ── Enhanced deduplication ─────────────────

export interface DedupeContext {
  recentLinks: string[];
  recentOfferKeys: string[];
  recentOfferCategories: string[];
  recentCtaTypes: string[];
}

export function buildDedupeContext(recentTimeline: Array<{ snippet_text?: string; metadata_json?: Record<string, unknown> }>): DedupeContext {
  const ctx: DedupeContext = {
    recentLinks: [],
    recentOfferKeys: [],
    recentOfferCategories: [],
    recentCtaTypes: [],
  };

  for (const item of recentTimeline) {
    const text = `${item.snippet_text || ""} ${JSON.stringify(item.metadata_json || {})}`.toLowerCase();

    // Extract URLs
    const urlMatches = text.match(/https?:\/\/[^\s"'<>]+/gi);
    if (urlMatches) ctx.recentLinks.push(...urlMatches.map(u => u.toLowerCase()));

    // Extract offer metadata if present
    const meta = item.metadata_json || {};
    if ((meta as any).offer_key) ctx.recentOfferKeys.push(String((meta as any).offer_key).toLowerCase());
    if ((meta as any).offer_category) ctx.recentOfferCategories.push(String((meta as any).offer_category).toLowerCase());
    if ((meta as any).cta_type) ctx.recentCtaTypes.push(String((meta as any).cta_type).toLowerCase());
  }

  return ctx;
}

export type DedupeVerdict = "ok" | "exact_link_sent" | "same_offer_family" | "same_cta_pattern";

export function checkOfferDedupe(
  offerKey: string,
  offerCategory: string,
  linkUrl: string | null,
  ctaType: string,
  dedupeCtx: DedupeContext,
): DedupeVerdict {
  // 1. Exact link
  if (linkUrl && dedupeCtx.recentLinks.includes(linkUrl.toLowerCase())) {
    return "exact_link_sent";
  }

  // 2. Same offer family (same key or same category recently)
  if (dedupeCtx.recentOfferKeys.includes(offerKey.toLowerCase())) {
    return "same_offer_family";
  }
  const catLower = offerCategory.toLowerCase();
  if (dedupeCtx.recentOfferCategories.filter(c => c === catLower).length >= 2) {
    return "same_offer_family";
  }

  // 3. Same CTA pattern used 2+ times recently
  const ctaLower = ctaType.toLowerCase();
  if (dedupeCtx.recentCtaTypes.filter(c => c === ctaLower).length >= 2) {
    return "same_cta_pattern";
  }

  return "ok";
}
