// Shared automation enable/disable logic for the lead-detail automation control.
//
// Extracted verbatim from AutomationPreviewCard so the slim Automation toggle
// (AutomationToggleCard) and the full control surface (AutomationPreviewCard)
// compute the SAME field writes — single source of truth, no divergence.
// This is presentation plumbing only: the field values and reason codes are
// unchanged from the pre-Unit-3 inline logic. The executor's pause-on-reply /
// pause-on-meeting safety behavior is unaffected (it lives server-side).

import { addDays } from "date-fns";
import { getMotionIntervals, getNurtureCadenceDays } from "@/lib/cadenceSettingsTypes";
import type { LeadDetail } from "@/lib/supabaseQueries";

// Step labels — generic per the product decision (independent of inbound/outbound branch).
// The cadence type (warm vs cold) is reflected by the underlying ai_task,
// not by a different display name in the UI.
export const OUTBOUND_STEP_LABELS: Record<string, string> = {
  send_pre_1: "Step 1 of 4",
  send_pre_2: "Step 2 of 4",
  send_pre_3: "Step 3 of 4",
  send_pre_4: "Step 4 of 4",
};

export const INBOUND_STEP_LABELS: Record<string, string> = {
  send_pre_1: "Step 1 of 3",
  send_pre_2: "Step 2 of 3",
  send_pre_3: "Step 3 of 3",
};

export const NURTURE_STEP_LABELS: Record<string, string> = {
  nurture_1: "Nurture Email 1",
  nurture_2: "Nurture Email 2",
  nurture_3: "Nurture Email 3",
  nurture_4: "Nurture Email 4",
};

export function getStepLabels(motion: string): Record<string, string> {
  if (motion === "inbound_response") return INBOUND_STEP_LABELS;
  if (motion === "nurture") return NURTURE_STEP_LABELS;
  return OUTBOUND_STEP_LABELS;
}

// Safety blockers that pause automation. Mirrors the executor's gating reasons
// so the UI reflects (does not drive) the server-side pause behavior.
export function getAutomationBlockers(lead: LeadDetail): string[] {
  const blockers: string[] = [];
  if (lead.last_inbound_at) blockers.push("Lead has replied");
  if (lead.has_future_meeting) blockers.push("Meeting scheduled");
  if (lead.motion !== "outbound_prospecting" && lead.motion !== "inbound_response" && lead.motion !== "nurture") blockers.push("Motion changed");
  const stage = lead.stage;
  if (stage === "closed_won" || stage === "closed_lost") blockers.push("Deal closed");
  return blockers;
}

// True once a lead has ever been enrolled in automation (consent given, a step
// scheduled, or a next action queued). Distinguishes a first-time enable from a
// resume of a previously-enrolled-but-paused lead.
export function automationEverEnabled(lead: LeadDetail): boolean {
  return (lead as any).automation_mode != null || !!(lead as any).eligible_at || !!lead.next_action_key;
}

// The blocker that should PREVENT turning automation on, or null if allowed.
// Mirrors the legacy split exactly: the old "Enable Automation" path applied NO
// blocker check (so a first inbound/lookback-seeded lead — which legitimately
// carries last_inbound_at — can still be enrolled), while the old "Resume" path
// refused to restart a previously-enrolled lead while a safety blocker (reply /
// meeting / closed / motion change) persists. The executor's server-side
// pause-on-reply / pause-on-meeting is unchanged and remains the real guard.
export function getAutomationResumeBlocker(lead: LeadDetail): string | null {
  if (!automationEverEnabled(lead)) return null; // first-time enable — unguarded
  const blockers = getAutomationBlockers(lead);
  return blockers.length > 0 ? blockers[0] : null;
}

// Derived display state for the slim Automation toggle. Concentrates the tricky
// boolean logic in one tested place so the switch never misreports whether
// emails are actually going out.
export interface AutomationToggleState {
  /** Whether the toggle card renders at all (motion eligible + not closed). */
  eligible: boolean;
  isUnsubscribed: boolean;
  safetyPaused: boolean;
  userPaused: boolean;
  /** Switch checked = automation is actively sending RIGHT NOW. Excludes the
   *  safety-paused window so a just-replied lead never reads as "sending". */
  isOn: boolean;
  /** First safety blocker (for the one-line status), or null. */
  primaryBlocker: string | null;
}

export function getAutomationToggleState(lead: LeadDetail): AutomationToggleState {
  const motion = lead.motion;
  const stage = lead.stage;
  const isUnsubscribed = (lead as any).unsubscribed === true;
  const eligible =
    (motion === "outbound_prospecting" || motion === "inbound_response" || motion === "nurture") &&
    stage !== "closed_won" && stage !== "closed_lost";

  const hasAutomationEnabled = !!(lead as any).eligible_at && lead.needs_action;
  const blockers = getAutomationBlockers(lead);
  const safetyPaused = blockers.length > 0 && automationEverEnabled(lead);
  const userPaused = !hasAutomationEnabled && !!lead.next_action_key && !safetyPaused;
  // ON strictly means actively sending now: enabled AND not in a safety-pause
  // window. During the reply/meeting window (flags not yet cleared by the
  // executor) hasAutomationEnabled can still be true, so exclude safetyPaused.
  const isOn = hasAutomationEnabled && !safetyPaused;

  return {
    eligible,
    isUnsubscribed,
    safetyPaused,
    userPaused,
    isOn,
    primaryBlocker: blockers[0] ?? null,
  };
}

// Fields written when automation is fully turned off / stopped (clears the
// sequence + revokes consent). Used by Disable and Stop Sequence.
export const AUTOMATION_DISABLE_FIELDS: Record<string, unknown> = {
  needs_action: false,
  next_action_key: null,
  next_action_label: null,
  eligible_at: null,
  action_reason_code: null,
  automation_mode: null,
};

// Fields written when automation is enabled from scratch (first turn-on).
// Branches on nurture vs outbound/inbound exactly as the original inline code.
export function buildAutomationEnableFields(lead: LeadDetail): Record<string, unknown> {
  const motion = lead.motion || "outbound_prospecting";
  const stepLabels = getStepLabels(motion);
  const intervals = getMotionIntervals(motion);

  if (motion === "nurture") {
    const cadence = (lead as any).nurture_cadence || "biweekly";
    const gapDays = getNurtureCadenceDays(cadence);
    const stepNum = ((lead as any).nurture_outbound_count || 0) + 1;
    let eligibleAt = addDays(new Date(), gapDays);
    eligibleAt.setHours(9, 30, 0, 0);
    if (eligibleAt.getTime() <= Date.now()) eligibleAt = addDays(eligibleAt, 1);

    return {
      needs_action: true,
      next_action_key: `nurture_${stepNum}`,
      next_action_label: `Nurture Email ${stepNum}`,
      eligible_at: eligibleAt.toISOString(),
      action_reason_code: "NURTURE_DUE",
      automation_mode: "full_auto", // explicit consent — required by executor consent gate
      nurture_status: "active",
      nurture_mode: (lead as any).nurture_mode || "review",
    };
  }

  const hasOutbound = !!(lead as any).last_outbound_at;
  const nextKey = hasOutbound ? (lead.next_action_key || "send_pre_2") : "send_pre_1";
  const nextLabel = stepLabels[nextKey] || "Step 1 of 4";
  const stepIdx = parseInt(nextKey.replace("send_pre_", ""), 10) - 1;
  const gapDays = stepIdx > 0 && stepIdx < intervals.length
    ? intervals[stepIdx] - intervals[stepIdx - 1]
    : (hasOutbound ? intervals[1] - intervals[0] : 0);

  let eligibleAt: Date;
  if (gapDays === 0) {
    eligibleAt = new Date();
    eligibleAt.setMinutes(eligibleAt.getMinutes() + 5);
  } else {
    eligibleAt = addDays(new Date(), gapDays);
    eligibleAt.setHours(9, 30, 0, 0);
    if (eligibleAt.getTime() <= Date.now()) eligibleAt = addDays(eligibleAt, 1);
  }

  return {
    needs_action: true,
    next_action_key: nextKey,
    next_action_label: nextLabel,
    eligible_at: eligibleAt.toISOString(),
    action_reason_code: "FOLLOWUP_DUE",
    automation_mode: "full_auto", // explicit consent — required by executor consent gate
  };
}
