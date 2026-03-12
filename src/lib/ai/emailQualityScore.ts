// ============================================
// COLD EMAIL QUALITY SCORER — Types & Utilities
// ============================================

export interface EmailQualityScore {
  curiosity: number;       // 0–10: Does the opening create curiosity?
  human_tone: number;      // 0–10: Does it sound human, not marketing?
  spam_risk: number;       // 0–10: Does it avoid spam triggers?
  reply_likelihood: number; // 0–10: How likely to get a reply?
  summary: string;         // Short explanation
}

export interface ScoredEmail {
  email_body: string;
  quality_score: EmailQualityScore;
  regenerated: boolean;
  framework_used: string;
}

export type EmailFramework = "curiosity" | "observation" | "hypothesis" | "ultra_short";

/**
 * Total quality score threshold.
 * If total (curiosity + human_tone + spam_risk + reply_likelihood) < 24,
 * the email is regenerated once using the curiosity framework.
 */
export const QUALITY_THRESHOLD = 24;

/** Check if the total score passes the quality bar */
export function passesQualityThreshold(score: EmailQualityScore): boolean {
  const total = score.curiosity + score.human_tone + score.spam_risk + score.reply_likelihood;
  return total >= QUALITY_THRESHOLD;
}

/** Compute the total score */
export function totalScore(score: EmailQualityScore): number {
  return score.curiosity + score.human_tone + score.spam_risk + score.reply_likelihood;
}

/**
 * Select the best email framework based on available context.
 *
 * Rules:
 * - If signals exist (hiring, funding, expansion, etc.) → observation
 * - If strong industry pain point is identifiable → hypothesis
 * - Otherwise → curiosity
 */
export function selectEmailFramework(
  signals: { type: string; description: string }[],
  industry?: string,
  leadContext?: string,
): EmailFramework {
  // If we have concrete signals, use observation framework
  if (signals && signals.length > 0) {
    const hasActionableSignal = signals.some(s =>
      ["hiring", "funding", "expansion", "product_launch", "new_partnership", "press_coverage"]
        .includes(s.type)
    );
    if (hasActionableSignal) return "observation";
  }

  // If we have industry context suggesting a known pain point, use hypothesis
  if (industry || leadContext) {
    const context = `${industry || ""} ${leadContext || ""}`.toLowerCase();
    const painIndicators = [
      "manual", "spreadsheet", "legacy", "outdated", "inefficient",
      "scaling", "bottleneck", "turnover", "compliance", "regulation",
    ];
    if (painIndicators.some(p => context.includes(p))) {
      return "hypothesis";
    }
  }

  // Default: curiosity framework
  return "curiosity";
}
