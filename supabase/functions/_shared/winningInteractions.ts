/**
 * Shared utility for capturing winning interactions.
 * Called from sync pipelines when a positive outcome is detected.
 */

import { logger } from "./logger.ts";

export type OutcomeType = "meeting_booked" | "positive_reply" | "deal_won";

interface CaptureParams {
  supabaseAdmin: any; // service-role client
  userId: string;
  leadId: string;
  messageContent: string;
  channel: string;
  outcomeType: OutcomeType;
}

/**
 * Captures a winning interaction. Resolves workspace_id from workspace_members.
 * Non-blocking: errors are logged but never thrown.
 */
export async function captureWinningInteraction(params: CaptureParams): Promise<void> {
  const { supabaseAdmin, userId, leadId, messageContent, channel, outcomeType } = params;

  try {
    // Don't store empty or trivially short messages
    if (!messageContent || messageContent.trim().length < 30) return;

    // Resolve workspace_id
    const { data: membership } = await supabaseAdmin
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", userId)
      .limit(1)
      .single();

    if (!membership?.workspace_id) {
      logger.warn("winning_interaction_no_workspace", { userId, leadId });
      return;
    }

    // Dedupe: skip if same lead + outcome_type within last 24h
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await supabaseAdmin
      .from("winning_interactions")
      .select("id")
      .eq("lead_id", leadId)
      .eq("outcome_type", outcomeType)
      .gte("created_at", oneDayAgo)
      .limit(1)
      .maybeSingle();

    if (existing) {
      logger.info("winning_interaction_dedupe_skip", { leadId, outcomeType });
      return;
    }

    await supabaseAdmin.from("winning_interactions").insert({
      workspace_id: membership.workspace_id,
      lead_id: leadId,
      message_content: messageContent.slice(0, 5000), // cap at 5k chars
      channel,
      outcome_type: outcomeType,
    });

    logger.info("winning_interaction_captured", { leadId, outcomeType, channel });
  } catch (err) {
    logger.error("winning_interaction_capture_error", { error: String(err), leadId, outcomeType });
  }
}
