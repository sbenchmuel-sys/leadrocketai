// Post-Send Sequence State Updater — updates lead fields after email is sent
import { supabase } from "@/integrations/supabase/client";
import type { AITaskType } from "@/hooks/useAITask";
import { calculateClosingPower } from "@/lib/closingPowerUtils";
import { getLeadDetail } from "@/lib/supabaseQueries";

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

// ============================================
// MAIN: updateSequenceState
// ============================================

export async function updateSequenceState(
  leadId: string,
  intentUsed: AITaskType,
  recommendedIntent?: AITaskType | null,
  overrideIntent?: AITaskType | null
): Promise<SequenceUpdateResult> {
  console.log("[updateSequenceState] Updating for lead", leadId, "intent:", intentUsed);

  // Step 1: Get field updates based on intent
  const fieldUpdates = getFieldUpdatesForIntent(intentUsed);

  // Build update payload
  const updatePayload: Record<string, unknown> = {
    last_outbound_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
    ...fieldUpdates,
  };

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

    // In review mode, don't auto-queue — user must manually generate next
    const mode = (lead as any)?.nurture_mode || "review";
    if (mode === "review") {
      updatePayload.next_action_key = null;
      updatePayload.next_action_label = null;
      updatePayload.needs_action = false;
    } else {
      // Automatic mode: queue next nurture
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

  // Step 2: Apply updates
  const { error } = await supabase
    .from("leads")
    .update(updatePayload)
    .eq("id", leadId);

  if (error) {
    console.error("[updateSequenceState] Failed to update lead:", error);
    throw error;
  }

  console.log("[updateSequenceState] Lead updated:", updatePayload);

  // Step 3: Log override event if intent was overridden
  let overrideLogged = false;
  if (overrideIntent && recommendedIntent && overrideIntent !== recommendedIntent) {
    console.log("[updateSequenceState] Override detected:", {
      recommended: recommendedIntent,
      used: overrideIntent,
    });

    // Record as an interaction for audit trail
    try {
      await supabase.from("interactions").insert({
        lead_id: leadId,
        type: "system_note",
        source: "pipeline",
        body_text: `Intent override: recommended "${recommendedIntent}" → used "${overrideIntent}"`,
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
