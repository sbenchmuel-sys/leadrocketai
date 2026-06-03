// ============================================
// PURE CAMPAIGN STEP CONFIG HELPERS
// Extracted from campaignStepLoader.ts so the resolver (and unit tests)
// can consume step-config logic WITHOUT pulling in the Supabase client
// (esm.sh URL import). campaignStepLoader.ts re-exports these for
// back-compat; the only NEW logic here is the rule-based fallback for
// steps beyond the literal 1–4 definitions (Unit B, 4→9 cadence).
//
// IMPORTANT: steps 1–4 keep their EXACT prior fallback chain so any
// pre-existing (≤4-step) campaign resolves byte-identically. The
// rule-based branch only ever runs for step_number > 4.
// ============================================

import type {
  CanonicalChannel,
  CampaignStepConfig,
} from "./campaignTypes.ts";
import {
  CHANNEL_STEP_CONSTRAINTS,
  CHANNEL_CTA_DEFAULTS,
  DEFAULT_STEP_CONFIG,
} from "./campaignTypes.ts";

// ── Types ───────────────────────────────────────────────────────────

export interface StructuredCampaignStep {
  step_number: number;
  step_type: string;
  channel: string;
  framework: string | null;
  objective: string | null;
  cta_type: string;
  max_word_count: number | null;
  hard_rules: string[];
  generation_hints: string[];
  custom_instructions: string | null;
  delay_days: number;
  active: boolean;
  variant_group?: string | null;
}

export interface LoadedCampaign {
  id: string;
  motion: string;
  default_channel: string;
  include_meeting_cta: boolean;
  global_instructions: string | null;
  steps: StructuredCampaignStep[];
}

// ── Rule-based defaults for extended steps (step_number > 4) ─────────
// Keyed on step_type so a 9-touch cadence stays sensible without
// enumerating every step number. These ONLY apply when a step beyond 4
// has no explicit value in its DB row.

const STEP_TYPE_FRAMEWORK: Record<string, string> = {
  intro: "neutral_observation",
  followup: "hypothesis",
  value_add: "value_add",
  breakup: "breakup",
  nurture: "value_add",
  re_engagement: "neutral_observation",
};

const STEP_TYPE_OBJECTIVE: Record<string, string> = {
  intro: "Get a reply by being specific and human",
  followup: "Give them a new reason to reply — different angle",
  value_add: "Share proof or value — make it easy to say yes",
  breakup: "Close the loop respectfully",
  nurture: "Offer a value-add resource — be genuinely helpful",
  re_engagement: "Re-engage with a fresh angle — soft check-in",
};

// Which literal step (1–4) constraint tier a given step_type borrows
// from, for word counts / hard rules / CTA defaults.
const STEP_TYPE_TIER: Record<string, number> = {
  intro: 1,
  followup: 2,
  value_add: 3,
  breakup: 4,
  nurture: 3,
  re_engagement: 2,
};

// ── Send-eligibility gate (pure) ────────────────────────────────────

/**
 * Whether a campaign with the given status may drive LIVE sends.
 *
 * Only 'active' campaigns send. draft / paused / completed never do. A
 * missing status (null/undefined — older type defs / pre-migration rows)
 * is treated as sendable to fail safe, matching the historical default
 * before the status column existed. This is the single source of truth for
 * the send-path gate in loadCampaignForLead; authoring (loadCampaignById)
 * deliberately does NOT consult it.
 */
export function isCampaignSendable(status: string | null | undefined): boolean {
  return status == null || status === "active";
}

// ── Step config conversion ──────────────────────────────────────────

/**
 * Convert a structured campaign step into a CampaignStepConfig
 * that the resolver can consume directly.
 *
 * Steps 1–4: unchanged fallback chain (DB value → DEFAULT_STEP_CONFIG →
 * CHANNEL_STEP_CONSTRAINTS). Steps > 4: when a DB column is empty, fall
 * back by step_type via the tables above instead of intro-tier defaults.
 */
export function structuredStepToConfig(
  step: StructuredCampaignStep,
  campaign: LoadedCampaign,
): CampaignStepConfig {
  const channel = (step.channel || campaign.default_channel) as CanonicalChannel;
  const stepNum = step.step_number;
  const isExtended = stepNum > 4;

  // For ≤4 steps the tier IS the step number, so behavior is identical to
  // the original code. For >4 steps borrow the tier for the step_type.
  const tierStep = isExtended ? (STEP_TYPE_TIER[step.step_type] ?? 2) : stepNum;

  const channelConstraint = CHANNEL_STEP_CONSTRAINTS[channel]?.[tierStep];
  const defaultConfig = DEFAULT_STEP_CONFIG[tierStep];

  const ruleFramework = isExtended ? STEP_TYPE_FRAMEWORK[step.step_type] : undefined;
  const ruleObjective = isExtended ? STEP_TYPE_OBJECTIVE[step.step_type] : undefined;

  return {
    step_type: step.step_type as CampaignStepConfig["step_type"],
    channel,
    objective: step.objective || ruleObjective || defaultConfig?.objective || "Get a reply",
    framework: step.framework || ruleFramework || defaultConfig?.framework || "neutral_observation",
    max_words: step.max_word_count || channelConstraint?.max_words || 75,
    max_words_with_instructions: channelConstraint?.max_words_with_instructions || 120,
    cta_type: step.cta_type || CHANNEL_CTA_DEFAULTS[channel]?.[tierStep] || "question",
    sequence_position: stepNum,
    hard_rules: [
      ...(channelConstraint?.hard_rules || []),
      ...(step.hard_rules || []),
    ],
    active: step.active,
  };
}

/**
 * Find and convert the step config for a specific step number.
 * Returns null if no matching active step exists.
 */
export function getStructuredStepConfig(
  campaign: LoadedCampaign,
  stepNumber: number,
): CampaignStepConfig | null {
  const step = campaign.steps.find((s) => s.step_number === stepNumber && s.active);
  if (!step) return null;
  return structuredStepToConfig(step, campaign);
}
