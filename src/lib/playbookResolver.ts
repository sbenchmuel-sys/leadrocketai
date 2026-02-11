// Playbook Resolver — determines recommended intent, playbook, and next step
import type { AITaskType } from "@/hooks/useAITask";
import type { ResolvedContext } from "@/lib/contextResolver";

// ============================================
// TYPES
// ============================================

export interface PlaybookRecommendation {
  recommended_intent: AITaskType;
  recommended_playbook: string;
  next_sequence_step: string;
}

// ============================================
// RESOLVER (priority-ordered rules)
// ============================================

export function playbookResolver(ctx: ResolvedContext): PlaybookRecommendation {
  // Rule 1: Meeting exists and recap not sent
  if (ctx.meeting_packs.length > 0 && ctx.has_unsent_recap) {
    return {
      recommended_intent: "post_meeting_followup_email",
      recommended_playbook: "Post-Meeting Follow-up",
      next_sequence_step: "Recap Email",
    };
  }

  // Rule 2: Inbound reply exists and no outbound after it
  if (ctx.last_inbound_email && ctx.last_outbound_email) {
    const inboundTime = new Date(ctx.last_inbound_email.occurred_at).getTime();
    const outboundTime = new Date(ctx.last_outbound_email.occurred_at).getTime();
    if (inboundTime > outboundTime) {
      return {
        recommended_intent: "reply_to_thread",
        recommended_playbook: "Reply to Inbound",
        next_sequence_step: "Reply",
      };
    }
  } else if (ctx.last_inbound_email && !ctx.last_outbound_email) {
    return {
      recommended_intent: "reply_to_thread",
      recommended_playbook: "Reply to Inbound",
      next_sequence_step: "Reply",
    };
  }

  // Rule 3: Nurture motion
  if (ctx.motion === "nurture") {
    const nextStep = ctx.nurture_outbound_count + 1;
    const STEP_LABELS = ["Industry Insight", "Case Study", "Value-Add Resource"];
    const stepLabel = STEP_LABELS[(nextStep - 1) % STEP_LABELS.length];
    return {
      recommended_intent: "nurture_email_single",
      recommended_playbook: `Nurture · ${ctx.nurture_theme || "balanced"}`,
      next_sequence_step: `Email ${nextStep}: ${stepLabel}`,
    };
  }

  // Rule 4: Closing motion
  if (ctx.motion === "closing") {
    return {
      recommended_intent: "pre_email_3_followup",
      recommended_playbook: "Closing",
      next_sequence_step: "Closing Nudge",
    };
  }

  // Rule 5: Map directly from next_action_key
  const actionKey = ctx.lead.next_action_key;
  if (actionKey) {
    const mapped = mapActionKeyToIntent(actionKey, ctx.thread_emails.length > 0);
    if (mapped) return mapped;
  }

  // Rule 6: Default — derive from motion + source_type
  return deriveDefault(ctx);
}

// ============================================
// ACTION KEY MAPPING (reuses existing logic patterns)
// ============================================

function mapActionKeyToIntent(actionKey: string, hasThread: boolean): PlaybookRecommendation | null {
  if (actionKey === "reply_now") {
    return {
      recommended_intent: hasThread ? "reply_to_thread" : "pre_email_1_intro",
      recommended_playbook: hasThread ? "Reply to Inbound" : "Outbound Prospecting",
      next_sequence_step: hasThread ? "Reply" : "Step 1 of 4",
    };
  }

  if (actionKey.startsWith("send_pre_1")) {
    return {
      recommended_intent: "pre_email_1_intro",
      recommended_playbook: "Outbound Prospecting",
      next_sequence_step: "Step 1 of 4",
    };
  }
  if (actionKey.startsWith("send_pre_2")) {
    return {
      recommended_intent: "pre_email_2_followup",
      recommended_playbook: "Outbound Prospecting",
      next_sequence_step: "Step 2 of 4",
    };
  }
  if (actionKey.startsWith("send_pre_3")) {
    return {
      recommended_intent: "pre_email_3_followup",
      recommended_playbook: "Outbound Prospecting",
      next_sequence_step: "Step 3 of 4",
    };
  }
  if (actionKey.startsWith("send_pre_4")) {
    return {
      recommended_intent: "pre_email_4_breakup",
      recommended_playbook: "Outbound Prospecting",
      next_sequence_step: "Step 4 of 4",
    };
  }

  if (actionKey === "generate_post_meeting_recap" || actionKey === "post_meeting_followup") {
    return {
      recommended_intent: "post_meeting_followup_email",
      recommended_playbook: "Post-Meeting Follow-up",
      next_sequence_step: "Recap Email",
    };
  }

  if (actionKey.startsWith("send_nurture_")) {
    const match = actionKey.match(/send_nurture_(\d+)/);
    const step = match ? parseInt(match[1], 10) : 1;
    return {
      recommended_intent: "nurture_email_single",
      recommended_playbook: "Nurture",
      next_sequence_step: `Nurture Email ${step}`,
    };
  }

  if (actionKey === "send_proposal" || actionKey === "closing_followup") {
    return {
      recommended_intent: "pre_email_3_followup",
      recommended_playbook: "Closing",
      next_sequence_step: "Closing Nudge",
    };
  }

  return null;
}

// ============================================
// DEFAULT DERIVATION
// ============================================

function deriveDefault(ctx: ResolvedContext): PlaybookRecommendation {
  const hasThread = ctx.thread_emails.length > 0;

  // Inbound sources default to reply or intro
  if (ctx.source_type === "contact_form" || ctx.source_type === "gmail_inbound" || ctx.source_type === "referral") {
    return {
      recommended_intent: hasThread ? "reply_to_thread" : "pre_email_1_intro",
      recommended_playbook: hasThread ? "Inbound Response" : "Inbound Intro",
      next_sequence_step: hasThread ? "Reply" : "Introduction",
    };
  }

  // Outbound default sequence
  if (!hasThread) {
    return {
      recommended_intent: "pre_email_1_intro",
      recommended_playbook: "Outbound Prospecting",
      next_sequence_step: "Step 1 of 4",
    };
  }

  // Has thread but no specific action — follow up
  return {
    recommended_intent: "pre_email_2_followup",
    recommended_playbook: "Outbound Prospecting",
    next_sequence_step: "Follow-up",
  };
}
