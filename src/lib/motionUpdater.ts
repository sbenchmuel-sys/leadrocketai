/**
 * Mode Control — updates lead motion from the dashboard table dropdown.
 * Maps user-facing display phases to internal motion + sequence state.
 *
 * Safety: automation stays OFF, no emails auto-sent, no drafts generated.
 */

import { supabase } from "@/integrations/supabase/client";
import { refreshDashboard } from "@/lib/dashboardMetricsService";
import type { DisplayPhase } from "@/lib/dashboardUtils";

export type ModeOption = "Prospecting" | "Engaged" | "Pre-Meeting" | "Post-Meeting" | "Closing" | "Nurture" | "Closed";

export const MODE_OPTIONS: ModeOption[] = [
  "Prospecting",
  "Engaged",
  "Pre-Meeting",
  "Post-Meeting",
  "Closing",
  "Nurture",
  "Closed",
];

interface MotionUpdate {
  motion: string;
  stage: string;
  nurture_mode?: string;
  nurture_status?: string;
  nurture_cadence?: string | null;
  nurture_theme?: string | null;
  needs_action?: boolean;
  next_action_key?: string | null;
  next_action_label?: string | null;
  action_reason_code?: string | null;
  auto_nurture_eligible?: boolean;
  mode_changed_at: string;
}

function buildUpdate(mode: ModeOption): MotionUpdate {
  const now = new Date().toISOString();
  const base: MotionUpdate = { motion: "", stage: "", mode_changed_at: now };

  switch (mode) {
    case "Prospecting":
      return {
        ...base,
        motion: "outbound_prospecting",
        stage: "contacted",
        nurture_mode: "off",
        nurture_status: "inactive",
        nurture_cadence: null,
        nurture_theme: null,
      };

    case "Engaged":
      return {
        ...base,
        motion: "inbound_response",
        stage: "engaged",
        nurture_mode: "off",
        nurture_status: "inactive",
        nurture_cadence: null,
        nurture_theme: null,
      };

    case "Pre-Meeting":
      return {
        ...base,
        motion: "pre_meeting",
        stage: "engaged",
      };

    case "Post-Meeting":
      return {
        ...base,
        motion: "post_meeting",
        stage: "post_meeting",
      };

    case "Closing":
      return {
        ...base,
        motion: "closing",
        stage: "closing",
      };

    case "Nurture":
      // Default cadence applied; dialog handles optional override
      return {
        ...base,
        motion: "nurture",
        stage: "contacted",
        nurture_cadence: "biweekly",
        nurture_mode: "review",
        nurture_status: "active",
        nurture_theme: "balanced",
        auto_nurture_eligible: false,
        needs_action: true,
        next_action_key: "send_nurture_1",
        next_action_label: "Review first nurture email",
        action_reason_code: null,
      };

    case "Closed":
      return {
        ...base,
        motion: "closed",
        stage: "closed_lost",
        nurture_mode: "off",
        nurture_status: "inactive",
        nurture_cadence: null,
        nurture_theme: null,
        needs_action: false,
        next_action_key: null,
        next_action_label: null,
        action_reason_code: null,
        auto_nurture_eligible: false,
      };

    default:
      return base;
  }
}

/**
 * Apply a mode change from the table dropdown.
 * Returns true on success.
 * For "Nurture", the caller should show the NurtureSwitchDialog instead
 * of calling this directly.
 */
export async function updateMotionFromTable(
  leadId: string,
  mode: ModeOption,
): Promise<boolean> {
  const update = buildUpdate(mode);

  const { error } = await supabase
    .from("leads")
    .update(update)
    .eq("id", leadId);

  if (error) {
    console.error("[motionUpdater] failed:", error);
    return false;
  }

  // Fire-and-forget dashboard refresh
  refreshDashboard("motion_updated");
  return true;
}

/**
 * Update nurture cadence for a lead (called from cadence edit dialog).
 */
export async function updateNurtureCadence(
  leadId: string,
  cadence: "weekly" | "biweekly" | "monthly",
): Promise<boolean> {
  const { error } = await supabase
    .from("leads")
    .update({ nurture_cadence: cadence })
    .eq("id", leadId);

  if (error) {
    console.error("[motionUpdater] cadence update failed:", error);
    return false;
  }
  return true;
}
