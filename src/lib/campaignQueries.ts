// ============================================
// CAMPAIGN CRUD QUERIES
// Client-side helpers for reading/writing structured campaigns
// ============================================

import { supabase } from "@/integrations/supabase/client";
import type { CanonicalChannel } from "@/lib/channels";
import type { StepType } from "@/lib/campaignTypes";

// ── Types (mirrors DB schema) ──────────────────────────────────────

export type CampaignMotion =
  | "outbound_prospecting"
  | "nurture"
  | "inbound_response"
  | "post_meeting"
  | "closing"
  | "re_engagement";

export interface Campaign {
  id: string;
  workspace_id: string;
  name: string;
  motion: CampaignMotion;
  default_channel: CanonicalChannel;
  include_meeting_cta: boolean;
  global_instructions: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface CampaignStep {
  id: string;
  campaign_id: string;
  step_number: number;
  step_type: StepType;
  channel: CanonicalChannel;
  framework: string | null;
  objective: string | null;
  cta_type: string;
  max_word_count: number | null;
  hard_rules: string[];
  generation_hints: string[];
  custom_instructions: string | null;
  delay_days: number;
  active: boolean;
  variant_group: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignWithSteps extends Campaign {
  steps: CampaignStep[];
}

// ── Queries ─────────────────────────────────────────────────────────

/** Fetch campaign + steps for a lead (via leads.campaign_id) */
export async function fetchCampaignForLead(leadId: string): Promise<CampaignWithSteps | null> {
  // First get the lead's campaign_id
  const { data: lead } = await supabase
    .from("leads")
    .select("campaign_id")
    .eq("id", leadId)
    .maybeSingle();

  if (!lead?.campaign_id) return null;
  return fetchCampaignById(lead.campaign_id);
}

/** Fetch a campaign by ID with its steps */
export async function fetchCampaignById(campaignId: string): Promise<CampaignWithSteps | null> {
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();

  if (!campaign) return null;

  const { data: steps } = await supabase
    .from("campaign_steps")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("step_number", { ascending: true });

  return {
    ...campaign,
    steps: (steps || []) as unknown as CampaignStep[],
  } as unknown as CampaignWithSteps;
}

/** List all campaigns for a workspace */
export async function fetchWorkspaceCampaigns(workspaceId: string): Promise<Campaign[]> {
  const { data } = await supabase
    .from("campaigns")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  return (data || []) as unknown as Campaign[];
}

/** Get the default campaign for a workspace + motion */
export async function fetchDefaultCampaign(
  workspaceId: string,
  motion: CampaignMotion = "outbound_prospecting",
): Promise<CampaignWithSteps | null> {
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("motion", motion)
    .eq("is_default", true)
    .maybeSingle();

  if (!campaign) return null;

  const { data: steps } = await supabase
    .from("campaign_steps")
    .select("*")
    .eq("campaign_id", campaign.id)
    .order("step_number", { ascending: true });

  return {
    ...campaign,
    steps: (steps || []) as unknown as CampaignStep[],
  } as unknown as CampaignWithSteps;
}

/** Assign a campaign to a lead */
export async function assignCampaignToLead(leadId: string, campaignId: string | null) {
  return supabase
    .from("leads")
    .update({ campaign_id: campaignId } as any)
    .eq("id", leadId);
}
