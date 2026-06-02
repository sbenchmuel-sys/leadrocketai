// ============================================
// STRUCTURED CAMPAIGN STEP LOADER
// Server-side helper that loads structured campaign steps
// from the DB and converts them into resolver-compatible format.
// Falls back to legacy text parsing when no structured campaign exists.
// ============================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type {
  CanonicalChannel,
  CampaignStepConfig,
  ResolvedInstruction,
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
}

export interface LoadedCampaign {
  id: string;
  motion: string;
  default_channel: string;
  include_meeting_cta: boolean;
  global_instructions: string | null;
  steps: StructuredCampaignStep[];
}

// ── Loader ──────────────────────────────────────────────────────────

/**
 * Load structured campaign + steps for a lead.
 * Returns null if the lead has no campaign_id or the campaign doesn't exist.
 */
export async function loadCampaignForLead(
  leadId: string,
  serviceClient: ReturnType<typeof createClient>,
): Promise<LoadedCampaign | null> {
  // Get lead's campaign_id
  const { data: lead } = await serviceClient
    .from("leads")
    .select("campaign_id")
    .eq("id", leadId)
    .maybeSingle();

  if (!lead?.campaign_id) return null;

  // Load campaign
  const { data: campaign } = await serviceClient
    .from("campaigns")
    .select("id, motion, default_channel, include_meeting_cta, global_instructions, status")
    .eq("id", lead.campaign_id)
    .maybeSingle();

  if (!campaign) return null;

  // Only an ACTIVE campaign may drive live sends. Draft / paused / completed
  // outreaches must never influence production messaging — a lead can be added
  // to a draft for membership (leads.campaign_id) without changing its send
  // behavior; the campaign takes effect when it is activated (Unit C). Returning
  // null here falls the executor back to the legacy action_instructions path,
  // i.e. exactly the pre-campaign behavior. Pre-existing campaigns are
  // backfilled to 'active' by migration 20260602000000 so nothing currently
  // live changes. (The `status` column may be absent on older type defs — guard
  // defensively: treat a missing value as active to avoid disabling live rows.)
  const campaignStatus = (campaign as { status?: string | null }).status;
  if (campaignStatus != null && campaignStatus !== "active") return null;

  // Load steps
  const { data: steps } = await serviceClient
    .from("campaign_steps")
    .select("step_number, step_type, channel, framework, objective, cta_type, max_word_count, hard_rules, generation_hints, custom_instructions, delay_days, active")
    .eq("campaign_id", campaign.id)
    .order("step_number", { ascending: true });

  return {
    id: campaign.id,
    motion: campaign.motion,
    default_channel: campaign.default_channel,
    include_meeting_cta: campaign.include_meeting_cta,
    global_instructions: campaign.global_instructions,
    steps: (steps || []) as StructuredCampaignStep[],
  };
}

/**
 * Convert a structured campaign step into a CampaignStepConfig
 * that the resolver can consume directly.
 */
export function structuredStepToConfig(
  step: StructuredCampaignStep,
  campaign: LoadedCampaign,
): CampaignStepConfig {
  const channel = (step.channel || campaign.default_channel) as CanonicalChannel;
  const stepNum = step.step_number;

  // Use DB values, falling back to channel constraints
  const channelConstraint = CHANNEL_STEP_CONSTRAINTS[channel]?.[stepNum];
  const defaultConfig = DEFAULT_STEP_CONFIG[stepNum];

  return {
    step_type: step.step_type as CampaignStepConfig["step_type"],
    channel,
    objective: step.objective || defaultConfig?.objective || "Get a reply",
    framework: step.framework || defaultConfig?.framework || "neutral_observation",
    max_words: step.max_word_count || channelConstraint?.max_words || 75,
    max_words_with_instructions: channelConstraint?.max_words_with_instructions || 120,
    cta_type: step.cta_type || CHANNEL_CTA_DEFAULTS[channel]?.[stepNum] || "question",
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
 * Returns null if no matching step exists.
 */
export function getStructuredStepConfig(
  campaign: LoadedCampaign,
  stepNumber: number,
): CampaignStepConfig | null {
  const step = campaign.steps.find(s => s.step_number === stepNumber && s.active);
  if (!step) return null;
  return structuredStepToConfig(step, campaign);
}
