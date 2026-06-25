// ============================================
// PURE CAMPAIGN STEP CONFIG HELPERS
// Extracted from campaignStepLoader.ts so the resolver (and unit tests)
// can consume step-config logic WITHOUT pulling in the Supabase client
// (esm.sh URL import). campaignStepLoader.ts re-exports these for
// back-compat; the only NEW logic here is the rule-based fallback for
// steps beyond the literal 1–4 definitions (Unit B, 4→9 cadence).
//
// IMPORTANT: any campaign with ≤4 active steps keeps its EXACT prior fallback
// chain (ordinal tiers), so every pre-existing campaign resolves byte-identically.
// The rule-based (step_type-tier) branch only runs for campaigns LONGER than 4
// steps — which can only be new Unit B drafts, never an existing live campaign.
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
  // Per-step meeting-link override (email touches). null/undefined = inherit the
  // campaign-level default (today's behavior); true = force the booking link on
  // for this touch; false = force it off. Read at generation time (Unit 3) as the
  // per-step source of truth — see resolveStepMeetingCta in campaignResolver.ts.
  include_meeting_cta?: boolean | null;
}

export interface LoadedCampaign {
  id: string;
  /** Owning workspace — used to validate the campaign's knowledge document (fail-closed). */
  workspace_id: string;
  motion: string;
  default_channel: string;
  include_meeting_cta: boolean;
  global_instructions: string | null;
  /**
   * The campaign's uploaded knowledge document (kb_chunks.document_id), or null.
   * Member-writable, so it MUST be validated (validateCampaignKnowledgeDoc) before
   * it is trusted to scope KB retrieval — never use it raw.
   */
  knowledge_document_id: string | null;
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
 * Tier selection is gated on the CAMPAIGN'S LENGTH, not the step number:
 *   • ≤4 active steps (legacy / existing campaigns): the tier IS the ordinal
 *     step number, so every step resolves byte-identically to the original
 *     code — regardless of its step_type.
 *   • >4 active steps (Unit B 9-touch cadences): the tier is chosen by
 *     step_type for EVERY step. This matters because the default 9-touch plan
 *     puts a `followup` at step 3 and a `value_add` at step 4 — keying off the
 *     ordinal there would wrongly hand step 3 the value_add defaults and step 4
 *     the breakup defaults. Long campaigns can only be new drafts (the loader
 *     is active-only and Unit A/B expose no activation path), so existing live
 *     campaigns are unaffected.
 */
export function structuredStepToConfig(
  step: StructuredCampaignStep,
  campaign: LoadedCampaign,
): CampaignStepConfig {
  const channel = (step.channel || campaign.default_channel) as CanonicalChannel;
  const stepNum = step.step_number;

  // Long = more than 4 active steps. Gate by length, not stepNum, so steps 1–4
  // of a long campaign also use step_type tiers (Codex P2, PR #58).
  const isLongCampaign = campaign.steps.filter((s) => s.active).length > 4;
  const tierStep = isLongCampaign ? (STEP_TYPE_TIER[step.step_type] ?? 2) : stepNum;

  const channelConstraint = CHANNEL_STEP_CONSTRAINTS[channel]?.[tierStep];
  const defaultConfig = DEFAULT_STEP_CONFIG[tierStep];

  const ruleFramework = isLongCampaign ? STEP_TYPE_FRAMEWORK[step.step_type] : undefined;
  const ruleObjective = isLongCampaign ? STEP_TYPE_OBJECTIVE[step.step_type] : undefined;

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
