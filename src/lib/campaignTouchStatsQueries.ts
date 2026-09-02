// ============================================================================
// Per-cadence outreach touch stats — client data layer.
//
// Reads from the get_campaign_touch_stats SECURITY DEFINER RPC. The RPC owns
// both the counting and the authorization (any workspace member). We never
// aggregate campaign_touch / campaign_enrollment directly here: those tables
// are owner-scoped, so a direct client query under-counts shared cadences.
// ============================================================================

import { supabase } from "@/integrations/supabase/client";

export interface CampaignTouchStats {
  campaignId: string;
  campaignName: string;
  campaignStatus: string;
  enrolled: number;
  sent: number;
  handled: number;
  skipped: number;
  pending: number;
  failed: number;
  replied: number;
}

interface StatsRow {
  campaign_id: string;
  campaign_name: string;
  campaign_status: string;
  enrolled: number | string;
  sent: number | string;
  handled: number | string;
  skipped: number | string;
  pending: number | string;
  failed: number | string;
  replied: number | string;
}

const n = (v: number | string | null | undefined) => Number(v) || 0;

export async function fetchCampaignTouchStats(
  workspaceId: string,
): Promise<CampaignTouchStats[]> {
  const { data, error } = await supabase.rpc("get_campaign_touch_stats" as any, {
    _workspace_id: workspaceId,
  });
  if (error) throw new Error(error.message || "Couldn't load outreach stats");
  return ((data as StatsRow[] | null) ?? []).map((r) => ({
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    campaignStatus: r.campaign_status,
    enrolled: n(r.enrolled),
    sent: n(r.sent),
    handled: n(r.handled),
    skipped: n(r.skipped),
    pending: n(r.pending),
    failed: n(r.failed),
    replied: n(r.replied),
  }));
}

/** Reply rate as a whole percentage of delivered touches (email sent + manual handled). */
export function replyRate(s: CampaignTouchStats): number | null {
  const delivered = s.sent + s.handled;
  if (delivered === 0) return null;
  return Math.round((s.replied / delivered) * 100);
}
