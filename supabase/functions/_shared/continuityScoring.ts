// ============================================
// CONTINUITY-AWARE SCORING
// Penalizes repeated assets, offers, CTAs
// based on deal_memory state
// ============================================

import type { DealMemory, ContinuityHints } from "./dealMemory.ts";
import type { ResolvedPolicy } from "./stagePolicy.ts";

// ── Offer score adjustment by continuity ──

export interface ContinuityScoreAdjustment {
  original_score: number;
  adjusted_score: number;
  penalties_applied: string[];
}

export function adjustOfferScoreByContinuity(
  baseScore: number,
  offerKey: string,
  offerCategory: string,
  offerCtaType: string,
  memory: DealMemory,
  hints: ContinuityHints,
): ContinuityScoreAdjustment {
  let score = baseScore;
  const penalties: string[] = [];
  const catLower = offerCategory.toLowerCase();

  // ── 1. Penalize already-sent offers ──
  if (memory.sent_offers.includes(offerKey)) {
    score -= 8;
    penalties.push(`sent_offer:${offerKey}(-8)`);
  }
  // Penalize same offer family (fuzzy match on category)
  const sentOfferFamilies = memory.sent_offers.map(o => o.split("_").slice(0, 2).join("_"));
  const offerFamily = offerKey.split("_").slice(0, 2).join("_");
  if (sentOfferFamilies.includes(offerFamily) && !memory.sent_offers.includes(offerKey)) {
    score -= 4;
    penalties.push(`sent_offer_family:${offerFamily}(-4)`);
  }

  // ── 2. Penalize CTA type if fatigued ──
  if (hints.should_vary_cta) {
    const lastCta = memory.recent_cta_patterns[memory.recent_cta_patterns.length - 1];
    if (offerCtaType === lastCta) {
      score -= 5;
      penalties.push(`cta_fatigue:${lastCta}(-5)`);
    }
  }
  // Extra penalty for high ignored count
  if (memory.ignored_cta_count >= 3 && (offerCtaType === "commitment" || offerCtaType === "meeting_request")) {
    score -= 4;
    penalties.push(`ignored_cta_heavy_cta(-4)`);
  }

  // ── 3. Momentum-based adjustments ──
  if (memory.momentum_state === "stalled" || memory.momentum_state === "regressing") {
    // Penalize aggressive commercial offers
    if (/urgency|limited_time|discount|close/i.test(catLower)) {
      score -= 5;
      penalties.push(`momentum_${memory.momentum_state}_aggressive(-5)`);
    }
    // Boost re-engagement / proof / nurture offers
    if (/nurture|case_study|proof|insight/i.test(catLower)) {
      score += 3;
      penalties.push(`momentum_${memory.momentum_state}_reengagement(+3)`);
    }
  }
  if (memory.momentum_state === "progressing") {
    // Slight boost for commercial advancement offers
    if (/product_specific|demo|financing|volume/i.test(catLower)) {
      score += 2;
      penalties.push("momentum_progressing_commercial(+2)");
    }
  }
  if (memory.momentum_state === "mixed") {
    // Boost friction-resolution offers
    if (/trial|sample|roi_calculator|case_study/i.test(catLower)) {
      score += 2;
      penalties.push("momentum_mixed_friction_resolution(+2)");
    }
  }

  // ── 4. Pending buy-in adjustments ──
  if (hints.prioritize_buyin) {
    if (/summary|one_pager|roi_summary|executive_brief|easy_forward/i.test(catLower)) {
      score += 4;
      penalties.push("pending_buyin_forwardable(+4)");
    }
    if (/meeting|commitment|close/i.test(offerCtaType)) {
      score -= 3;
      penalties.push("pending_buyin_suppress_pressure(-3)");
    }
  }

  return {
    original_score: baseScore,
    adjusted_score: score,
    penalties_applied: penalties,
  };
}

// ── Stage policy adjustments that consider momentum ──

export function adjustStagePolicyByMomentum(
  policy: ResolvedPolicy,
  memory: DealMemory,
  hints: ContinuityHints,
): {
  cta_overrides: string[];
  suppressed_cta_additions: string[];
  preferred_cta_additions: string[];
  reasoning: string[];
} {
  const cta_overrides: string[] = [];
  const suppressed_additions: string[] = [];
  const preferred_additions: string[] = [];
  const reasoning: string[] = [];

  // Stalled: suppress pressure CTAs, prefer re-engagement
  if (hints.is_stalled) {
    suppressed_additions.push("commitment", "close_now", "meeting_request");
    preferred_additions.push("soft_offer", "timing_check", "proof_based");
    reasoning.push("momentum_stalled→suppress_pressure");
  }

  // Regressing: stronger suppression, prefer low-pressure
  if (hints.is_regressing) {
    suppressed_additions.push("commitment", "close_now", "direct_offer", "meeting_request");
    preferred_additions.push("soft_offer", "quick_question", "timing_check");
    reasoning.push("momentum_regressing→low_pressure_only");
  }

  // CTA fatigue: suppress the repeated CTA
  if (hints.should_vary_cta && hints.preferred_cta_override) {
    const lastCta = memory.recent_cta_patterns[memory.recent_cta_patterns.length - 1];
    if (lastCta) suppressed_additions.push(lastCta);
    preferred_additions.push(hints.preferred_cta_override);
    cta_overrides.push(hints.preferred_cta_override);
    reasoning.push(`cta_fatigue:${lastCta}→${hints.preferred_cta_override}`);
  }

  // Pending buy-in: suppress pressure regardless of stage
  if (hints.prioritize_buyin) {
    suppressed_additions.push("commitment", "meeting_request");
    preferred_additions.push("easy_forward", "proof_based");
    reasoning.push("pending_buyin→suppress_meeting+commitment");
  }

  return {
    cta_overrides,
    suppressed_cta_additions: [...new Set(suppressed_additions)],
    preferred_cta_additions: [...new Set(preferred_additions)],
    reasoning,
  };
}
