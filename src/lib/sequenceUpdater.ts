// Post-Send Sequence State Updater — updates lead fields after email is sent
import { supabase } from "@/integrations/supabase/client";
import type { AITaskType } from "@/hooks/useAITask";
import { calculateClosingPower } from "@/lib/closingPowerUtils";
import { getLeadDetail } from "@/lib/supabaseQueries";
import { addDays } from "date-fns";

// ============================================
// TYPES
// ============================================

export interface SequenceUpdateResult {
  updated_fields: Record<string, unknown>;
  override_logged: boolean;
  closing_power: number;
}

// ============================================
// INTENT → LEAD FIELD MAPPING
// ============================================

interface FieldUpdate {
  motion?: string;
  stage?: string;
  next_action_key?: string | null;
  next_action_label?: string | null;
  needs_action?: boolean;
}

function getFieldUpdatesForIntent(intent: AITaskType): FieldUpdate {
  // Phase 6: Automation OFF by default — never auto-queue next steps.
  // Sequence progression is recorded but no future emails are scheduled
  // unless automation is explicitly enabled (future phase).
  switch (intent) {
    case "pre_email_1_intro":
      return {
        stage: "contacted",
        next_action_key: null,
        next_action_label: null,
        needs_action: false,
      };
    case "pre_email_2_followup":
      return {
        next_action_key: null,
        next_action_label: null,
        needs_action: false,
      };
    case "pre_email_3_followup":
      return {
        next_action_key: null,
        next_action_label: null,
        needs_action: false,
      };
    case "pre_email_4_breakup":
      return {
        next_action_key: null,
        next_action_label: null,
        needs_action: false,
      };
    case "post_meeting_followup_email":
    case "post_meeting_followup_personalized":
      return {
        motion: "post_meeting",
        stage: "post_meeting",
        next_action_key: null,
        next_action_label: null,
        needs_action: false,
      };
    case "reply_to_thread":
      return {
        stage: "engaged",
        needs_action: false,
      };
    case "nurture_email_single":
      // Nurture step increment handled separately in updateSequenceState
      return {
        motion: "nurture",
        needs_action: false,
      };
    default:
      return {
        needs_action: false,
      };
  }
}

// WhatsApp-specific intent detection
function isWhatsAppIntent(intent: AITaskType): boolean {
  return intent === "pre_email_2_followup" || intent === "pre_email_1_intro";
}

// Check if intent is part of the outbound email sequence
function isOutboundSequenceIntent(intent: AITaskType): boolean {
  return ["pre_email_1_intro", "pre_email_2_followup", "pre_email_3_followup", "pre_email_4_breakup"].includes(intent);
}

// Get the next step key in the outbound sequence
function getNextOutboundStep(intent: AITaskType): string | null {
  const progression: Record<string, string> = {
    pre_email_1_intro: "send_pre_2",
    pre_email_2_followup: "send_pre_3",
    pre_email_3_followup: "send_pre_4",
  };
  return progression[intent] || null; // pre_email_4_breakup has no next step
}

// ============================================
// MAIN: updateSequenceState
// ============================================

export async function updateSequenceState(
  leadId: string,
  intentUsed: AITaskType,
  recommendedIntent?: AITaskType | null,
  overrideIntent?: AITaskType | null,
  channel: "email" | "linkedin" | "whatsapp" = "email",
  previousSequenceStep?: string | null,
  motionOverride?: string | null
): Promise<SequenceUpdateResult> {
  console.log("[updateSequenceState] Updating for lead", leadId, "intent:", intentUsed, "channel:", channel);

  // Step 0: Fetch pre-update lead state for automation eligibility check
  let wasAutomationActive = false;
  if (channel === "email" && isOutboundSequenceIntent(intentUsed)) {
    try {
      const { data: preLead } = await supabase
        .from("leads")
        .select("eligible_at, needs_action, last_inbound_at, has_future_meeting, motion, stage")
        .eq("id", leadId)
        .single();
      wasAutomationActive = !!(preLead?.eligible_at) && !!(preLead?.needs_action);
    } catch (err) {
      console.warn("[updateSequenceState] Pre-check failed:", err);
    }
  }

  // Step 1: Get field updates based on intent
  const fieldUpdates = getFieldUpdatesForIntent(intentUsed);

  // Build update payload
  const updatePayload: Record<string, unknown> = {
    last_outbound_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
  };

  if (channel === "whatsapp") {
    if (fieldUpdates.motion) updatePayload.motion = fieldUpdates.motion;
    if (fieldUpdates.stage) updatePayload.stage = fieldUpdates.stage;
    updatePayload.needs_action = false;
  } else {
    Object.assign(updatePayload, fieldUpdates);
  }

  // Apply motion override if provided (from composer dropdown)
  if (motionOverride) {
    updatePayload.motion = motionOverride;
    // Reset sequence fields on motion change
    updatePayload.next_action_key = null;
    updatePayload.next_action_label = null;
    updatePayload.needs_action = false;
    if (motionOverride === "closed") {
      updatePayload.nurture_status = "inactive";
    }
    if (motionOverride === "nurture") {
      updatePayload.nurture_status = "active";
      updatePayload.nurture_mode = "review";
    }
  }

  // Set first_outbound_at if this is the first outbound
  if (intentUsed === "pre_email_1_intro") {
    const { data: lead } = await supabase
      .from("leads")
      .select("first_outbound_at")
      .eq("id", leadId)
      .single();

    if (lead && !lead.first_outbound_at) {
      updatePayload.first_outbound_at = new Date().toISOString();
    }
  }

  // Nurture: increment outbound count and queue next step
  if (intentUsed === "nurture_email_single") {
    const { data: lead } = await supabase
      .from("leads")
      .select("nurture_outbound_count, nurture_mode")
      .eq("id", leadId)
      .single();

    const currentCount = (lead as any)?.nurture_outbound_count || 0;
    const nextCount = currentCount + 1;
    const nextStepKey = `send_nurture_${nextCount + 1}`;

    updatePayload.nurture_outbound_count = nextCount;
    updatePayload.last_nurture_outbound_at = new Date().toISOString();

    const mode = (lead as any)?.nurture_mode || "review";
    if (mode === "review") {
      updatePayload.next_action_key = null;
      updatePayload.next_action_label = null;
      updatePayload.needs_action = false;
    } else {
      updatePayload.next_action_key = nextStepKey;
      updatePayload.next_action_label = `Send nurture email #${nextCount + 1}`;
      updatePayload.needs_action = true;
    }

    console.log("[updateSequenceState] Nurture step incremented:", {
      previousCount: currentCount,
      newCount: nextCount,
      mode,
      nextStep: mode === "review" ? "manual" : nextStepKey,
    });
  }

  // Step 2: Apply updates (single atomic write)
  const { error } = await supabase
    .from("leads")
    .update(updatePayload)
    .eq("id", leadId);

  if (error) {
    console.error("[updateSequenceState] Failed to update lead:", error);
    throw error;
  }

  console.log("[updateSequenceState] Lead updated:", updatePayload);

  // Log motion override event if applicable
  if (motionOverride) {
    try {
      await supabase.from("interactions").insert({
        lead_id: leadId,
        type: "system_note",
        source: "composer",
        body_text: `Motion override → "${motionOverride}" (sequence reset)`,
        occurred_at: new Date().toISOString(),
      });
      console.log("[updateSequenceState] Motion override event logged");
    } catch (logErr) {
      console.warn("[updateSequenceState] Failed to log motion override:", logErr);
    }
  }

  // Step 2b: If automation WAS active before send, schedule next step (with safety re-check)
  if (wasAutomationActive) {
    try {
      const freshLead = await getLeadDetail(leadId);
      const hasReply = !!freshLead.last_inbound_at;
      const hasMeeting = freshLead.has_future_meeting;
      const motionChanged = freshLead.motion !== "outbound_prospecting";
      const isClosed = freshLead.stage === "closed_won" || freshLead.stage === "closed_lost";

      if (hasReply || hasMeeting || motionChanged || isClosed) {
        await supabase
          .from("leads")
          .update({ needs_action: false, eligible_at: null })
          .eq("id", leadId);
        console.log("[updateSequenceState] Automation paused — engagement detected:", {
          hasReply, hasMeeting, motionChanged, isClosed,
        });
      } else {
        const nextStep = getNextOutboundStep(intentUsed);
        if (nextStep) {
          const FAST_INTERVALS = [2, 3, 3, 4];
          const stepIdx = parseInt(nextStep.replace("send_pre_", ""), 10) - 1;
          const daysUntil = FAST_INTERVALS[stepIdx] || 3;
          const eligibleAt = addDays(new Date(), daysUntil);
          eligibleAt.setHours(9, 30, 0, 0);

          const STEP_LABELS: Record<string, string> = {
            send_pre_2: "Follow-up 1",
            send_pre_3: "Follow-up 2",
            send_pre_4: "Breakup Email",
          };

          await supabase
            .from("leads")
            .update({
              next_action_key: nextStep,
              next_action_label: STEP_LABELS[nextStep] || "Follow-up",
              needs_action: true,
              eligible_at: eligibleAt.toISOString(),
              action_reason_code: "FOLLOWUP_DUE",
            })
            .eq("id", leadId);

          console.log("[updateSequenceState] Automation: next step scheduled:", {
            nextStep,
            eligibleAt: eligibleAt.toISOString(),
          });
        }
      }
    } catch (err) {
      console.warn("[updateSequenceState] Automation scheduling failed (non-blocking):", err);
    }
  }


  // Step 3: Log override event if intent was overridden
  let overrideLogged = false;
  if (overrideIntent && recommendedIntent && overrideIntent !== recommendedIntent) {
    console.log("[updateSequenceState] Override detected:", {
      suggested_intent: recommendedIntent,
      chosen_intent: overrideIntent,
      previous_sequence_step: previousSequenceStep || "unknown",
    });

    // Record as an interaction for audit trail
    try {
      await supabase.from("interactions").insert({
        lead_id: leadId,
        type: "system_note",
        source: "pipeline",
        body_text: JSON.stringify({
          event: "intent_override",
          suggested_intent: recommendedIntent,
          chosen_intent: overrideIntent,
          previous_sequence_step: previousSequenceStep || null,
        }),
        occurred_at: new Date().toISOString(),
      });
      overrideLogged = true;
    } catch (err) {
      console.warn("[updateSequenceState] Failed to log override:", err);
    }
  }

  // Step 4: Recalculate closing power
  let closingPower = 0;
  try {
    const freshLead = await getLeadDetail(leadId);
    const cpResult = calculateClosingPower(freshLead);
    closingPower = cpResult.total;
    console.log("[updateSequenceState] Closing power recalculated:", closingPower);
  } catch (err) {
    console.warn("[updateSequenceState] Failed to recalculate closing power:", err);
  }

  return {
    updated_fields: updatePayload,
    override_logged: overrideLogged,
    closing_power: closingPower,
  };
}
