// ============================================================================
// Campaign scorecard — client data layer (Unit 5, PR 5.1)
//
// Reads per-campaign rollups (enrolled / sent / replied / meetings) from the
// get_campaign_scorecard SECURITY DEFINER RPC. The RPC — not the client — owns
// BOTH the counting and the authorization:
//   • workspace-wide rollup  → admins only (the founder Insights page)
//   • a single campaign      → any workspace member (the CampaignDetail card)
// We never aggregate campaign_enrollment / campaign_touch directly here: those
// tables are owner-scoped, so a non-admin client query would under-count a
// shared campaign. One RPC call returns the true totals.
// ============================================================================

import { supabase } from "@/integrations/supabase/client";

export interface CampaignScorecard {
  campaignId: string;
  campaignName: string;
  enrolled: number;
  sent: number;
  replied: number;
  meetings: number;
}

// The RPC is new, so the generated types.ts doesn't know it yet (Lovable
// regenerates types only after the migration is applied). Cast at the boundary.
interface ScorecardRow {
  campaign_id: string;
  campaign_name: string;
  enrolled: number | string;
  sent: number | string;
  replied: number | string;
  meetings: number | string;
}

function mapRow(r: ScorecardRow): CampaignScorecard {
  // Postgres bigint can arrive as a string over PostgREST — coerce defensively.
  return {
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    enrolled: Number(r.enrolled) || 0,
    sent: Number(r.sent) || 0,
    replied: Number(r.replied) || 0,
    meetings: Number(r.meetings) || 0,
  };
}

/**
 * Workspace-wide rollup for the founder-only Insights page. One row per
 * campaign in the workspace, newest campaign first. Throws if the caller
 * isn't a workspace admin (the RPC fail-closes with 42501).
 */
export async function fetchWorkspaceScorecards(workspaceId: string): Promise<CampaignScorecard[]> {
  const { data, error } = await supabase.rpc("get_campaign_scorecard" as any, {
    _workspace_id: workspaceId,
    _campaign_id: null,
  });
  if (error) throw new Error(error.message || "Couldn't load campaign scorecards");
  return ((data as ScorecardRow[] | null) ?? []).map(mapRow);
}

/**
 * Compact rollup for a single campaign (the CampaignDetail card). Visible to
 * any workspace member. Returns null if the campaign isn't found in scope.
 */
export async function fetchCampaignScorecard(
  workspaceId: string,
  campaignId: string,
): Promise<CampaignScorecard | null> {
  const { data, error } = await supabase.rpc("get_campaign_scorecard" as any, {
    _workspace_id: workspaceId,
    _campaign_id: campaignId,
  });
  if (error) throw new Error(error.message || "Couldn't load the campaign scorecard");
  const rows = (data as ScorecardRow[] | null) ?? [];
  return rows.length ? mapRow(rows[0]) : null;
}
