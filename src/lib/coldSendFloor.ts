// ============================================
// COLD-SEND FLOOR (workspace gate, read-side)
// "Send automatically" on an outreach only makes email actually fire if the
// WORKSPACE floor is also met: the workspace-wide cold auto-send switch is on,
// a CAN-SPAM postal address exists, and a timezone is set (the executor enforces
// all three — automation-executor/index.ts). Without this, a rep can flip an
// outreach to auto-send and see nothing happen — a dead switch. This module
// reads the floor and explains, in plain language, what's still missing.
//
// This is the READ/EXPLAIN side only. The settings that flip these live in
// ColdOutreachSafetyCard; the real enforcement lives server-side.
// ============================================

import { supabase } from "@/integrations/supabase/client";

export interface ColdSendFloor {
  /** workspace_automation_settings.cold_auto_send_enabled */
  autoSendEnabled: boolean;
  /** workspaces.cold_outreach_postal_address is non-blank */
  hasPostalAddress: boolean;
  /** workspaces.timezone is set */
  hasTimezone: boolean;
}

export interface ColdSendFloorStatus {
  /** True when automatic email can actually fire for this workspace. */
  ready: boolean;
  /** Plain-language, rep-readable list of what's still missing (empty when ready). */
  reasons: string[];
}

/**
 * Turn the raw floor into a plain-language status. Each reason is a complete,
 * actionable sentence pointing at Settings — no jargon, no column names. Pure.
 */
export function describeColdSendFloor(floor: ColdSendFloor): ColdSendFloorStatus {
  const reasons: string[] = [];
  if (!floor.autoSendEnabled) {
    reasons.push("Turn on automatic cold sending for your workspace in Settings.");
  }
  if (!floor.hasPostalAddress) {
    reasons.push("Add your company mailing address in Settings (the law requires it on every email).");
  }
  if (!floor.hasTimezone) {
    reasons.push("Set your workspace time zone in Settings.");
  }
  return { ready: reasons.length === 0, reasons };
}

/** Read the three floor inputs for a workspace. Defaults fail-closed (not ready). */
export async function fetchColdSendFloor(workspaceId: string): Promise<ColdSendFloor> {
  const [{ data: ws }, { data: settings }] = await Promise.all([
    (supabase as any)
      .from("workspaces")
      .select("cold_outreach_postal_address, timezone")
      .eq("id", workspaceId)
      .maybeSingle(),
    (supabase as any)
      .from("workspace_automation_settings")
      .select("cold_auto_send_enabled")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
  ]);
  return {
    autoSendEnabled: !!settings?.cold_auto_send_enabled,
    hasPostalAddress: !!String(ws?.cold_outreach_postal_address ?? "").trim(),
    hasTimezone: !!ws?.timezone,
  };
}
