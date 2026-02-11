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
  switch (intent) {
    case "pre_email_1_intro":
      return {
        stage: "contacted",
        next_action_key: "send_pre_2_followup",
        next_action_label: "Follow-up #2",
        needs_action: false,
      };
    case "pre_email_2_followup":
      return {
        next_action_key: "send_pre_3_followup",
        next_action_label: "Follow-up #3",
        needs_action: false,
      };
    case "pre_email_3_followup":
      return {
        next_action_key: "send_pre_4_breakup",
        next_action_label: "Breakup email",
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
    // Only set if not already set — use a conditional update
    const { data: lead } = await supabase
      .from("leads")
      .select("first_outbound_at")
      .eq("id", leadId)
      .single();

    if (lead && !lead.first_outbound_at) {
      updatePayload.first_outbound_at = new Date().toISOString();
    }
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
