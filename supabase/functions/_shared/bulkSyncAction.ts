// ============================================================
// bulkSyncAction — gmail-bulk-sync's own action rule, lifted out verbatim
//
// `gmail-bulk-sync` is the ONLY Gmail path that runs on a cron, and it has
// always used this private, simplified `deriveAction` rather than
// `syncEngine.deriveAction`: its own 6-hour reply window, its own hardcoded
// cadence day numbers, no guardrails, no `eligible_at`. Its result is written
// straight onto the lead, so whatever it returns is the last word on the
// scheduled path.
//
// Moved here UNCHANGED (except for the Unit Q1 fallback at the bottom, and the
// `strategy` parameter that feeds it) for two reasons:
//   1. The entry file can't be imported outside Deno — it pulls `npm:` and
//      `deno.land` — so while this lived there, the scheduled path's behaviour
//      could only be asserted by grepping source text. That is the kind of
//      "test" that reads as safety and provides none.
//   2. The master plan lists this private rule for deletion in favour of the
//      shared one. A single file is a far smaller thing to delete than surgery
//      inside a 1,500-line handler.
//
// PURE: no Deno, no npm, no client. The metrics shape is declared structurally
// rather than imported from syncEngine, which is Deno-typed.
// ============================================================

import { deriveFollowupDue, followupWaitDays } from "./followupRule.ts";

export interface BulkSyncMetrics {
  first_outbound_at: string | null;
  last_outbound_at: string | null;
  last_inbound_at: string | null;
  meeting_summary_count: number;
  nurture_outbound_count: number;
  last_nurture_outbound_at: string | null;
}

export function deriveAction(
  metrics: BulkSyncMetrics,
  pendingDraftCount: number,
  nurtureCadence: string | null,
  stage: string,
  strategy: string = "fast",
  /**
   * The workspace's merged mode settings for this lead's strategy, so
   * `cadence_settings.modes.<fast|nurture>.followup_wait_days` is honoured on
   * the scheduled path too. Omitted → the 3/5 default. A setting that works
   * when a rep sends and is ignored by the job that actually surfaces leads is
   * worse than no setting: it looks configured.
   */
  modeSettings: { followup_wait_days?: number | null } | null = null
): { needs_action: boolean; next_action_key: string | null; next_action_label: string | null } {
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  if (metrics.last_inbound_at) {
    const inboundTime = new Date(metrics.last_inbound_at).getTime();
    const outboundTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
    
    if (inboundTime > outboundTime) {
      const elapsed = now - inboundTime;
      if (elapsed > 6 * HOUR) {
        return {
          needs_action: true,
          next_action_key: "reply_now",
          next_action_label: "Reply to customer",
        };
      }
    }
  }

  // Closing stage - follow up if no outbound in 3 days
  if (stage === "closing") {
    const lastOutTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
    if (now - lastOutTime > 3 * DAY) {
      return {
        needs_action: true,
        next_action_key: "closing_followup",
        next_action_label: "Follow up on proposal/contract",
      };
    }
  }

  if (metrics.first_outbound_at && !metrics.last_inbound_at && metrics.meeting_summary_count === 0) {
    const firstOutTime = new Date(metrics.first_outbound_at).getTime();
    const lastOutTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : firstOutTime;
    const daysSinceFirst = (now - firstOutTime) / DAY;
    const daysSinceLast = (now - lastOutTime) / DAY;

    if (daysSinceFirst >= 14 && daysSinceLast >= 7) {
      return {
        needs_action: true,
        next_action_key: "send_pre_4",
        next_action_label: "Send breakup email",
      };
    } else if (daysSinceFirst >= 7 && daysSinceLast >= 4) {
      return {
        needs_action: true,
        next_action_key: "send_pre_3",
        next_action_label: "Send follow-up Email 3",
      };
    } else if (daysSinceFirst >= 4 && daysSinceLast >= 3) {
      return {
        needs_action: true,
        next_action_key: "send_pre_2",
        next_action_label: "Send follow-up Email 2",
      };
    }
  }

  if (metrics.meeting_summary_count > 0) {
    const lastOutTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
    if (now - lastOutTime > 48 * HOUR) {
      return {
        needs_action: true,
        next_action_key: "generate_post_meeting_recap",
        next_action_label: "Send post-meeting recap",
      };
    }
  }

  if (metrics.nurture_outbound_count > 0 && nurtureCadence) {
    const lastNurtureTime = metrics.last_nurture_outbound_at 
      ? new Date(metrics.last_nurture_outbound_at).getTime() 
      : 0;
    
    let intervalDays = 7;
    if (nurtureCadence === "biweekly") intervalDays = 14;
    else if (nurtureCadence === "monthly") intervalDays = 30;

    if (now - lastNurtureTime >= intervalDays * DAY) {
      return {
        needs_action: true,
        next_action_key: `send_nurture_${metrics.nurture_outbound_count + 1}`,
        next_action_label: "Send nurture email",
      };
    }
  }

  // FOLLOW-UP DUE (Unit Q1) — the ONE place the scheduled Gmail path can close
  // the six-week hole.
  //
  // This private deriveAction is a simplified copy of syncEngine's, and its
  // pre-meeting branch has the same defect the shared one had: it gates on
  // `!metrics.last_inbound_at`, so a lead who replied once and then went quiet
  // falls through to this final `null` return. The scheduled sweep then WRITES
  // that null over the `followup_due` the shared rule produced elsewhere (see
  // the action-overwrite branch in syncLeadEmails), so before this change the
  // hole was closed for nobody on a schedule — Gmail included.
  //
  // Deliberately narrow: only the fallback changes. Every verdict this function
  // already reaches — reply_now, closing_followup, send_pre_N, the recap and
  // nurture branches, with their own hardcoded windows — is untouched, because
  // this is the function that was broken for ten weeks and only just stabilised.
  // Migrating it wholesale onto the shared rule is tracked in the plan
  // ("bulk-sync private deriveStage/deriveAction" → delete) and is not this
  // unit's job.
  //
  // No `eligible_at` is written here (this file is forbidden from scheduling
  // sends — see the consent gate in syncLeadEmails), so `followup_due` from the
  // scheduled path can never reach automation-executor.
  if (stage !== "closed_won" && stage !== "closed_lost") {
    const followupDue = deriveFollowupDue(metrics, followupWaitDays(strategy, modeSettings));
    if (followupDue) {
      return {
        needs_action: true,
        next_action_key: followupDue.next_action_key,
        next_action_label: followupDue.next_action_label,
      };
    }
  }

  return { needs_action: false, next_action_key: null, next_action_label: null };
}
