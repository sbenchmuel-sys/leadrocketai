// ============================================
// CLIENT-SIDE CAMPAIGN INSTRUCTION RESOLVER
// Mirrors the server-side campaignResolver.ts so that manual
// draft generation and step previews use the exact same logic
// as automation-executor. Any change here MUST be mirrored
// on the server side.
// ============================================

import type { CanonicalChannel } from "@/lib/channels";
import {
  OUTBOUND_STEPS,
  NURTURE_STEPS,
  type StepType,
} from "@/lib/campaignTypes";

// ── Action key → step number (mirrors server) ──────────────────────

const ACTION_KEY_TO_STEP: Record<string, number> = {
  send_pre_1: 1, send_pre_1_intro: 1,
  send_pre_2: 2, send_pre_2_followup: 2,
  send_pre_3: 3, send_pre_3_followup: 3,
  send_pre_4: 4, send_pre_4_breakup: 4,
  nurture_1: 1, nurture_2: 2, nurture_3: 3, nurture_4: 4,
  send_nurture_1: 1, send_nurture_2: 2, send_nurture_3: 3, send_nurture_4: 4,
};

// ── Channel × step word limits (mirrors server CHANNEL_STEP_CONSTRAINTS) ──

interface StepConstraint {
  max_words: number;
  max_words_with_instructions: number;
  hard_rules: string[];
}

const EMAIL_CONSTRAINTS: Record<number, StepConstraint> = {
  1: { max_words: 75, max_words_with_instructions: 120, hard_rules: ["2 short paragraphs max", "First sentence proves you know who they are", "Last sentence is a question (CTA)", "No feature lists, no attachments, no calendar links unless instructed"] },
  2: { max_words: 60, max_words_with_instructions: 90, hard_rules: ["Do NOT start with 'Just following up' / 'Checking in'", "Reference previous email briefly, then pivot to NEW angle", "One question only"] },
  3: { max_words: 60, max_words_with_instructions: 100, hard_rules: ["Lead with one concrete insight or result", "The insight must relate to THEIR industry", "Different angle than previous emails"] },
  4: { max_words: 40, max_words_with_instructions: 70, hard_rules: ["No guilt, no fake urgency", "Ask a direct yes/no question", "Leave the door open in one sentence"] },
};

const WHATSAPP_CONSTRAINTS: Record<number, StepConstraint> = {
  1: { max_words: 50, max_words_with_instructions: 60, hard_rules: ["No formal sign-offs", "One emoji max", "No subject line"] },
  2: { max_words: 50, max_words_with_instructions: 60, hard_rules: ["Different from msg 1", "No sign-off"] },
  3: { max_words: 50, max_words_with_instructions: 60, hard_rules: ["Keep it light", "One proof point"] },
  4: { max_words: 40, max_words_with_instructions: 50, hard_rules: ["No pressure", "Direct close question"] },
};

const CHANNEL_CONSTRAINTS: Record<string, Record<number, StepConstraint>> = {
  email: EMAIL_CONSTRAINTS,
  whatsapp: WHATSAPP_CONSTRAINTS,
};

// ── CTA defaults ────────────────────────────────────────────────────

const CTA_DEFAULTS: Record<string, Record<number, string>> = {
  email: { 1: "question", 2: "question", 3: "soft_offer", 4: "breakup_close" },
  whatsapp: { 1: "question", 2: "question", 3: "question", 4: "breakup_close" },
};

// ── Nurture step objectives ─────────────────────────────────────────

const NURTURE_OBJECTIVES: Record<number, string> = {
  1: "Share a relevant industry insight — build credibility, no pitch",
  2: "Provide a case study or proof point — show tangible results",
  3: "Offer a value-add resource — be genuinely helpful",
  4: "Re-engage with a fresh angle — soft check-in",
};

// ── Types ───────────────────────────────────────────────────────────

export interface ResolvedStepPreview {
  step_number: number;
  channel: CanonicalChannel;
  framework: string;
  objective: string;
  max_word_count: number;
  cta_type: string;
  hard_rules: string[];
  generation_hints: string[];
  step_type: StepType;
}

export interface ClientCampaignResolverInput {
  action_key: string | null;
  motion: string;
  channel?: CanonicalChannel;
  outbound_tone?: string;
  action_instructions?: string | null;
  has_reply?: boolean;
  meeting_booked?: boolean;
  include_meeting_cta?: boolean;
  calendar_link?: string | null;
  /** NEW: structured campaign step override from DB */
  structured_step?: {
    channel: CanonicalChannel;
    framework: string;
    objective: string;
    cta_type: string;
    max_word_count: number;
    hard_rules: string[];
    generation_hints: string[];
    custom_instructions?: string | null;
    step_type: StepType;
  } | null;
}

// ── Internal helpers ────────────────────────────────────────────────

function resolveStepNumber(actionKey: string | null): number {
  if (!actionKey) return 1;
  const mapped = ACTION_KEY_TO_STEP[actionKey];
  if (mapped) return mapped;
  const match = actionKey.match(/(\d+)/);
  return match ? Math.max(1, Math.min(parseInt(match[1], 10), 4)) : 1;
}

function resolveChannel(actionKey: string | null, explicit?: CanonicalChannel): CanonicalChannel {
  if (explicit) return explicit;
  if (actionKey?.startsWith("whatsapp_")) return "whatsapp";
  if (actionKey?.startsWith("sms_")) return "sms";
  if (actionKey?.startsWith("voice_") || actionKey?.startsWith("call_")) return "voice";
  return "email";
}

function resolveFramework(channel: CanonicalChannel, step: number, motion: string, isNurture: boolean): string {
  if (channel !== "email") return channel;
  if (isNurture) {
    if (step === 1) return "value_add";
    if (step === 2) return "value_add";
    if (step === 3) return "value_add";
    if (step === 4) return "neutral_observation"; // re-engage
    return "value_add";
  }
  if (step === 4) return "breakup";
  if (step === 3) return "value_add";
  if (step === 1) return "neutral_observation";
  return "hypothesis";
}

function deriveObjective(channel: CanonicalChannel, step: number, motion: string): string {
  if (motion === "nurture") return NURTURE_OBJECTIVES[step] || NURTURE_OBJECTIVES[1];
  if (motion === "inbound_response") return "Convert interest into a scheduled conversation";
  if (motion === "post_meeting") return "Move the deal forward with a clear next step";
  const objectives: Record<number, string> = {
    1: "Get a reply by being specific and human",
    2: "Give them a new reason to reply — different angle",
    3: "Share proof or value — make it easy to say yes",
    4: "Close the loop respectfully — get a yes or no",
  };
  return objectives[step] || objectives[1];
}

function resolveWordCount(channel: CanonicalChannel, step: number, hasCustom: boolean): number {
  const constraints = CHANNEL_CONSTRAINTS[channel];
  if (!constraints) return 75;
  const sc = constraints[step] || constraints[1];
  if (!sc) return 75;
  return hasCustom ? sc.max_words_with_instructions : sc.max_words;
}

function getHardRules(channel: CanonicalChannel, step: number): string[] {
  const constraints = CHANNEL_CONSTRAINTS[channel];
  return constraints?.[step]?.hard_rules || [];
}

function buildHints(channel: CanonicalChannel, step: number, tone?: string): string[] {
  const hints: string[] = [];
  if (step === 1) hints.push("Prove you know who they are in the first sentence");
  if (step === 2) hints.push("Reference previous email briefly, then pivot to a NEW angle");
  if (step === 3) hints.push("Lead with proof or a concrete result");
  if (step === 4) hints.push("No guilt, no urgency — direct yes/no question");
  if (channel === "whatsapp") hints.push("Casual, like a work friend texting. Max 50 words.");
  if (tone === "conversational") hints.push("Warm, relaxed, use contractions");
  if (tone === "assertive") hints.push("Confident, include specific offers");
  if (tone === "consultative") hints.push("Trusted advisor positioning, diagnostic questions");
  return hints;
}

function resolveStepType(motion: string, step: number): StepType {
  if (motion === "nurture") return "nurture";
  if (step === 1) return "intro";
  if (step === 4) return "breakup";
  if (step === 3) return "value_add";
  return "followup";
}

// ════════════════════════════════════════════
// PUBLIC: Resolve a single step for preview
// ════════════════════════════════════════════

export function resolveStepPreview(input: ClientCampaignResolverInput): ResolvedStepPreview {
  const step = resolveStepNumber(input.action_key);
  const channel = resolveChannel(input.action_key, input.channel);
  const isNurture = input.motion === "nurture";
  const hasCustom = !!(input.action_instructions?.trim());

  return {
    step_number: step,
    channel,
    framework: resolveFramework(channel, step, input.motion, isNurture),
    objective: deriveObjective(channel, step, input.motion),
    max_word_count: resolveWordCount(channel, step, hasCustom),
    cta_type: CTA_DEFAULTS[channel]?.[step] || "question",
    hard_rules: getHardRules(channel, step),
    generation_hints: buildHints(channel, step, input.outbound_tone),
    step_type: resolveStepType(input.motion, step),
  };
}

// ════════════════════════════════════════════
// PUBLIC: Resolve all steps for a lead (preview grid)
// ════════════════════════════════════════════

export function resolveAllSteps(
  motion: string,
  channel: CanonicalChannel = "email",
  actionInstructions?: string | null,
  outboundTone?: string,
): ResolvedStepPreview[] {
  const steps = motion === "nurture" ? NURTURE_STEPS : OUTBOUND_STEPS;
  const actionKeyPrefix = motion === "nurture" ? "nurture_" : "send_pre_";

  return steps.map(s => resolveStepPreview({
    action_key: `${actionKeyPrefix}${s.key}`,
    motion,
    channel,
    outbound_tone: outboundTone,
    action_instructions: actionInstructions,
  }));
}

// ════════════════════════════════════════════
// PUBLIC: Build payload fields for ai_task call
// Used by generateDraft.ts to match automation-executor
// ════════════════════════════════════════════

export function buildCampaignPayloadFields(input: ClientCampaignResolverInput): {
  campaign_instruction: string;
  campaign_meta: {
    channel: CanonicalChannel;
    framework: string;
    step_number: number;
    max_word_count: number;
    cta_type: string;
    has_custom_instructions: boolean;
  };
} {
  const preview = resolveStepPreview(input);

  // Build the same text block that formatInstructionForPrompt produces server-side
  const parts: string[] = [];
  parts.push(`=== CAMPAIGN INSTRUCTION (STRUCTURED) ===`);
  parts.push(`Channel: ${preview.channel}`);
  parts.push(`Framework: ${preview.framework}`);
  parts.push(`Objective: ${preview.objective}`);
  parts.push(`Sequence: Step ${preview.step_number} of 4`);
  parts.push(`Max words: ${preview.max_word_count}`);
  parts.push(`CTA type: ${preview.cta_type}`);

  if (preview.hard_rules.length > 0) {
    parts.push(`\nHARD RULES (mandatory):`);
    for (const rule of preview.hard_rules) {
      parts.push(`- ${rule}`);
    }
  }
  if (preview.generation_hints.length > 0) {
    parts.push(`\nGENERATION HINTS:`);
    for (const hint of preview.generation_hints) {
      parts.push(`- ${hint}`);
    }
  }
  if (input.action_instructions?.trim()) {
    parts.push(`\nCAMPAIGN CUSTOM INSTRUCTIONS (user-provided, MANDATORY):`);
    parts.push(input.action_instructions.trim());
  }
  parts.push(`=== END CAMPAIGN INSTRUCTION ===`);

  return {
    campaign_instruction: parts.join("\n"),
    campaign_meta: {
      channel: preview.channel,
      framework: preview.framework,
      step_number: preview.step_number,
      max_word_count: preview.max_word_count,
      cta_type: preview.cta_type,
      has_custom_instructions: !!(input.action_instructions?.trim()),
    },
  };
}
