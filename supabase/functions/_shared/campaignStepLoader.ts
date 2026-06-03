// ============================================
// STRUCTURED CAMPAIGN STEP LOADER
// Server-side helper that loads structured campaign steps from the DB.
// Pure step-config conversion + the send-eligibility gate live in
// campaignStepConfig.ts (re-exported below) so that logic is unit-testable
// without the Supabase (esm.sh) import this file needs for its DB calls.
// ============================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Pure helpers + types live in campaignStepConfig.ts (no Supabase import).
// Re-exported so existing importers keep working unchanged.
export type { StructuredCampaignStep, LoadedCampaign } from "./campaignStepConfig.ts";
export {
  structuredStepToConfig,
  getStructuredStepConfig,
  isCampaignSendable,
} from "./campaignStepConfig.ts";

import type { LoadedCampaign, StructuredCampaignStep } from "./campaignStepConfig.ts";
import { isCampaignSendable } from "./campaignStepConfig.ts";

const STEP_COLUMNS =
  "step_number, step_type, channel, framework, objective, cta_type, max_word_count, hard_rules, generation_hints, custom_instructions, delay_days, active, variant_group";

const CAMPAIGN_COLUMNS =
  "id, motion, default_channel, include_meeting_cta, global_instructions, status";

async function loadSteps(
  client: ReturnType<typeof createClient>,
  campaignId: string,
): Promise<StructuredCampaignStep[]> {
  const { data: steps } = await client
    .from("campaign_steps")
    .select(STEP_COLUMNS)
    .eq("campaign_id", campaignId)
    .order("step_number", { ascending: true });
  return (steps || []) as StructuredCampaignStep[];
}

function toLoadedCampaign(
  campaign: Record<string, unknown>,
  steps: StructuredCampaignStep[],
): LoadedCampaign {
  return {
    id: campaign.id as string,
    motion: campaign.motion as string,
    default_channel: campaign.default_channel as string,
    include_meeting_cta: campaign.include_meeting_cta as boolean,
    global_instructions: (campaign.global_instructions as string | null) ?? null,
    steps,
  };
}

/**
 * Load structured campaign + steps for a lead (the LIVE SEND path).
 * Returns null if the lead has no campaign_id, the campaign doesn't exist,
 * or — critically — the campaign is not ACTIVE (see isCampaignSendable).
 *
 * Only an ACTIVE campaign may drive live sends. Draft / paused / completed
 * outreaches must never influence production messaging: a lead can be added
 * to a draft for membership (leads.campaign_id) without changing its send
 * behavior; the campaign takes effect when it is activated (Unit C).
 * Returning null falls the executor back to the legacy action_instructions
 * path (pre-campaign behavior). Pre-existing campaigns were backfilled to
 * 'active' by migration 20260602000000. A missing status (older type defs)
 * is treated as active to fail safe.
 */
export async function loadCampaignForLead(
  leadId: string,
  serviceClient: ReturnType<typeof createClient>,
): Promise<LoadedCampaign | null> {
  const { data: lead } = await serviceClient
    .from("leads")
    .select("campaign_id")
    .eq("id", leadId)
    .maybeSingle();

  if (!lead?.campaign_id) return null;

  const { data: campaign } = await serviceClient
    .from("campaigns")
    .select(CAMPAIGN_COLUMNS)
    .eq("id", lead.campaign_id)
    .maybeSingle();

  if (!campaign) return null;

  // Send-path gate: draft / paused / completed never drive live sends.
  if (!isCampaignSendable((campaign as { status?: string | null }).status)) {
    return null;
  }

  const steps = await loadSteps(serviceClient, (campaign as { id: string }).id);
  return toLoadedCampaign(campaign as Record<string, unknown>, steps);
}

/**
 * Load a structured campaign by id for AUTHORING (status-agnostic).
 *
 * This is the generation/authoring entry point: a rep authors a DRAFT
 * outreach, so the active-only gate in loadCampaignForLead is exactly wrong
 * here. This loader intentionally ignores status. It must NEVER be used on
 * the live send path — that path keys on the lead via loadCampaignForLead so
 * draft / paused / completed campaigns stay inert.
 */
export async function loadCampaignById(
  campaignId: string,
  client: ReturnType<typeof createClient>,
): Promise<LoadedCampaign | null> {
  const { data: campaign } = await client
    .from("campaigns")
    .select(CAMPAIGN_COLUMNS)
    .eq("id", campaignId)
    .maybeSingle();

  if (!campaign) return null;

  const steps = await loadSteps(client, (campaign as { id: string }).id);
  return toLoadedCampaign(campaign as Record<string, unknown>, steps);
}
