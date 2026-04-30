// ============================================
// CANONICAL CAMPAIGN INSTRUCTION RESOLVER
// Single source of truth for resolving campaign step data
// into structured execution instructions for AI generation.
// Both manual send and automation-executor MUST use this.
// ============================================

import type { CanonicalChannel } from "./campaignTypes.ts";
import {
  CHANNEL_STEP_CONSTRAINTS,
  DEFAULT_STEP_CONFIG,
  ACTION_KEY_TO_STEP,
  CHANNEL_CTA_DEFAULTS,
  type CampaignStepConfig,
  type SequenceContext,
  type ResolvedInstruction,
} from "./campaignTypes.ts";
import type { LoadedCampaign } from "./campaignStepLoader.ts";
import { getStructuredStepConfig } from "./campaignStepLoader.ts";

// ── Input: everything the resolver needs ────────────────────────────

export interface CampaignResolverInput {
  // Lead state
  lead_id: string;
  action_key: string | null;       // e.g. "send_pre_2", "nurture_3"
  motion: string;                  // e.g. "outbound_prospecting", "nurture", "inbound_response"
  channel?: CanonicalChannel;      // explicit override; defaults to "email"
  outbound_tone?: string;          // per-lead tone: "direct" | "conversational" | "assertive" | "consultative"

  // Campaign / step raw instructions (legacy compat)
  action_instructions?: string | null;  // raw text from leads.action_instructions

  // NEW: structured campaign data (from DB)
  structured_campaign?: LoadedCampaign | null;

  // Sequence context signals
  prior_steps_sent?: number;       // how many outbound steps already sent
  prior_channels_used?: CanonicalChannel[];
  last_touch_at?: string | null;
  has_reply?: boolean;
  meeting_booked?: boolean;
  recent_objections?: string[];
  recent_signals?: string[];

  // Workspace config
  include_meeting_cta?: boolean;
  calendar_link?: string | null;
  playbook_id?: string;
}

// ── Step number extraction ──────────────────────────────────────────

function resolveStepNumber(actionKey: string | null): number {
  if (!actionKey) return 1;
  const mapped = ACTION_KEY_TO_STEP[actionKey];
  if (mapped) return mapped;
  const match = actionKey.match(/(\d+)/);
  return match ? Math.max(1, Math.min(parseInt(match[1], 10), 4)) : 1;
}

// ── Channel resolution ──────────────────────────────────────────────

function resolveChannel(actionKey: string | null, explicit?: CanonicalChannel): CanonicalChannel {
  if (explicit) return explicit;
  if (actionKey?.startsWith("whatsapp_")) return "whatsapp";
  if (actionKey?.startsWith("sms_")) return "sms";
  if (actionKey?.startsWith("voice_") || actionKey?.startsWith("call_")) return "voice";
  return "email";
}

// ── Framework selection ─────────────────────────────────────────────

type EmailFramework = "neutral_observation" | "observation" | "hypothesis" | "ultra_short" | "value_add" | "breakup" | "inbound_response";

function resolveEmailFramework(step: number, motion: string, hasSignals: boolean): EmailFramework {
  if (motion === "inbound_response") return "inbound_response";
  if (step === 4) return "breakup";
  if (step === 3) return "value_add";
  if (motion === "nurture") return "value_add";
  if (step === 1 && hasSignals) return "observation";
  if (step === 1) return "neutral_observation";
  return "hypothesis"; // follow-ups default
}

function resolveFramework(channel: CanonicalChannel, step: number, motion: string, hasSignals: boolean): string {
  if (channel === "email") return resolveEmailFramework(step, motion, hasSignals);
  // Non-email channels use channel name as framework identifier
  return channel;
}

// ── Objective derivation ────────────────────────────────────────────

function deriveObjective(channel: CanonicalChannel, step: number, motion: string): string {
  if (motion === "nurture") {
    // Step-specific nurture objectives — mirrors client campaignResolver.ts
    const nurtureObjectives: Record<number, string> = {
      1: "Share a relevant industry insight — build credibility, no pitch",
      2: "Provide a case study or proof point — show tangible results",
      3: "Offer a value-add resource — be genuinely helpful",
      4: "Re-engage with a fresh angle — soft check-in",
    };
    return nurtureObjectives[step] || nurtureObjectives[1];
  }
  if (motion === "inbound_response") return "Convert interest into a scheduled conversation";
  if (motion === "post_meeting") return "Move the deal forward with a clear next step";
  if (motion === "closing") return "Drive to commitment on outstanding decisions";

  // Outbound prospecting
  const objectives: Record<number, string> = {
    1: "Get a reply by being specific and human",
    2: "Give them a new reason to reply — different angle",
    3: "Share proof or value — make it easy to say yes",
    4: "Close the loop respectfully — get a yes or no",
  };
  return objectives[step] || objectives[1];
}

// ── Legacy instruction parser ───────────────────────────────────────
// Parses the raw text format: CAMPAIGN RULES + STEP N INSTRUCTIONS
// This maintains backward compatibility with existing campaigns.

interface ParsedLegacyInstructions {
  global_rules: string[];
  step_instructions: Record<number, string>;
}

function parseLegacyInstructions(raw: string | null | undefined): ParsedLegacyInstructions {
  const result: ParsedLegacyInstructions = { global_rules: [], step_instructions: {} };
  if (!raw) return result;

  const lines = raw.split("\n");
  let currentBlock: number | null = null;
  const stepLines: Record<number, string[]> = {};

  for (const line of lines) {
    const stepMatch = line.match(/^STEP\s+(\d+)\s+INSTRUCTIONS\s*:/i);
    if (stepMatch) {
      currentBlock = parseInt(stepMatch[1], 10);
      stepLines[currentBlock] = [];
    } else if (currentBlock !== null) {
      stepLines[currentBlock].push(line);
    } else {
      // Strip "CAMPAIGN RULES:" header if present
      const trimmed = line.replace(/^CAMPAIGN\s+RULES\s*:\s*/i, "").trim();
      if (trimmed) result.global_rules.push(trimmed);
    }
  }

  for (const [step, lines] of Object.entries(stepLines)) {
    const text = lines.join("\n").trim();
    if (text) result.step_instructions[parseInt(step, 10)] = text;
  }

  return result;
}

// ── CTA resolution ──────────────────────────────────────────────────

function resolveCTA(
  channel: CanonicalChannel,
  step: number,
  motion: string,
  includeCalendar: boolean,
  calendarLink: string | null | undefined,
  customInstructions: string | null,
): string {
  if (channel === "email" && motion === "inbound_response") {
    return calendarLink ? `meeting_booking:${calendarLink}` : "meeting_request";
  }
  // Custom instructions may specify CTA type
  if (customInstructions) {
    const lower = customInstructions.toLowerCase();
    if (/meeting|calendar|book.*time|schedule.*call/i.test(lower) && calendarLink) {
      return `meeting_booking:${calendarLink}`;
    }
    if (/starter.?kit|free.?trial|demo/i.test(lower)) return "offer";
  }
  if (includeCalendar && calendarLink && step >= 2) return `meeting_booking:${calendarLink}`;
  return CHANNEL_CTA_DEFAULTS[channel]?.[step] || "question";
}

// ── Sequence context builder ────────────────────────────────────────

function buildSequenceContext(input: CampaignResolverInput, stepNumber: number): SequenceContext {
  const daysSinceLastTouch = input.last_touch_at
    ? Math.floor((Date.now() - new Date(input.last_touch_at).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return {
    step_number: stepNumber,
    total_steps: 4, // standard outbound sequence
    prior_steps_sent: input.prior_steps_sent ?? (stepNumber - 1),
    prior_channels_used: input.prior_channels_used ?? [],
    days_since_last_touch: daysSinceLastTouch,
    has_reply: input.has_reply ?? false,
    meeting_booked: input.meeting_booked ?? false,
    recent_objections: input.recent_objections ?? [],
    recent_signals: input.recent_signals ?? [],
  };
}

// ── Word count constraints ──────────────────────────────────────────

function resolveWordCount(channel: CanonicalChannel, step: number, hasCustomInstructions: boolean): number {
  const channelConstraints = CHANNEL_STEP_CONSTRAINTS[channel];
  if (!channelConstraints) return 75;
  const stepConstraint = channelConstraints[step] || channelConstraints[1];
  if (!stepConstraint) return 75;
  // When custom instructions exist, allow expanded limits
  return hasCustomInstructions ? stepConstraint.max_words_with_instructions : stepConstraint.max_words;
}

// ── Hard rules assembly ─────────────────────────────────────────────

function buildHardRules(
  channel: CanonicalChannel,
  step: number,
  legacy: ParsedLegacyInstructions,
  tone: string,
): string[] {
  const rules: string[] = [];

  // Channel-specific constraints
  const channelConstraints = CHANNEL_STEP_CONSTRAINTS[channel];
  if (channelConstraints?.[step]?.hard_rules) {
    rules.push(...channelConstraints[step].hard_rules);
  }

  // Global campaign rules (from legacy format)
  rules.push(...legacy.global_rules);

  // Step-specific instructions (from legacy format)
  const stepInstr = legacy.step_instructions[step];
  if (stepInstr) {
    rules.push(`STEP ${step} SPECIFIC: ${stepInstr}`);
  }

  return rules;
}

// ════════════════════════════════════════════
// MAIN RESOLVER — the only function callers need
// ════════════════════════════════════════════

export function resolveCampaignInstruction(input: CampaignResolverInput): ResolvedInstruction {
  const stepNumber = resolveStepNumber(input.action_key);
  const channel = resolveChannel(input.action_key, input.channel);
  const hasSignals = (input.recent_signals?.length ?? 0) > 0;

  // ── NEW: Prefer structured campaign step from DB ──────────────────
  const structuredStep = input.structured_campaign
    ? getStructuredStepConfig(input.structured_campaign, stepNumber)
    : null;

  if (structuredStep) {
    // Structured path: all step data comes from DB, no text parsing
    const stepChannel = structuredStep.channel || channel;
    const sequenceContext = buildSequenceContext(input, stepNumber);
    const isInboundEmail = input.motion === "inbound_response" && stepChannel === "email";
    const customInstr = input.structured_campaign?.steps
      ?.find(s => s.step_number === stepNumber)?.custom_instructions || null;
    const globalInstr = input.structured_campaign?.global_instructions || null;
    const rawCustom = [globalInstr, customInstr].filter(Boolean).join("\n") || null;

    const hints: string[] = [
      ...(input.structured_campaign?.steps?.find(s => s.step_number === stepNumber)?.generation_hints || []) as string[],
    ];
    if (input.outbound_tone === "conversational") hints.push("Warm, relaxed, use contractions");
    if (input.outbound_tone === "assertive") hints.push("Confident, include specific offers");
    if (input.outbound_tone === "consultative") hints.push("Trusted advisor positioning");

    return {
      channel: stepChannel,
      framework: isInboundEmail ? "inbound_response" : structuredStep.framework,
      objective: isInboundEmail ? "Convert interest into a scheduled conversation" : structuredStep.objective,
      hard_rules: isInboundEmail ? [
        "Warm inbound response — they contacted us first",
        "Thank them for reaching out through the website/form and acknowledge their specific interest",
        "Briefly explain relevant company value from approved context",
        "Use a meeting CTA; include the calendar link if available, otherwise ask for availability",
        "Do not ask cold discovery questions such as their biggest challenge",
        "Do not use cold-observation framing",
      ] : structuredStep.hard_rules,
      generation_hints: isInboundEmail ? ["Open by acknowledging their inbound interest, then move toward a meeting", ...hints] : hints,
      sequence_context: sequenceContext,
      personalization_context: {
        tone: input.outbound_tone || "direct",
        playbook_id: input.playbook_id || "general_sales",
        include_meeting_cta: input.structured_campaign?.include_meeting_cta ?? input.include_meeting_cta ?? false,
        calendar_link: input.calendar_link || null,
      },
      max_word_count: structuredStep.max_words,
      cta_type: isInboundEmail
        ? (input.calendar_link ? `meeting_booking:${input.calendar_link}` : "meeting_request")
        : structuredStep.cta_type,
      raw_custom_instructions: rawCustom,
    };
  }

  // ── Legacy path: parse from raw text ──────────────────────────────
  const legacy = parseLegacyInstructions(input.action_instructions);
  const hasCustomInstructions = legacy.global_rules.length > 0 || Object.keys(legacy.step_instructions).length > 0;

  const framework = resolveFramework(channel, stepNumber, input.motion, hasSignals);
  const objective = deriveObjective(channel, stepNumber, input.motion);
  const sequenceContext = buildSequenceContext(input, stepNumber);
  const maxWordCount = resolveWordCount(channel, stepNumber, hasCustomInstructions);
  const hardRules = input.motion === "inbound_response" && channel === "email"
    ? [
      "Warm inbound response — they contacted us first",
      "Thank them for reaching out through the website/form and acknowledge their specific interest",
      "Briefly explain relevant company value from approved context",
      "Use a meeting CTA; include the calendar link if available, otherwise ask for availability",
      "Do not ask cold discovery questions such as their biggest challenge",
      "Do not use cold-observation framing",
    ]
    : buildHardRules(channel, stepNumber, legacy, input.outbound_tone || "direct");
  const ctaType = resolveCTA(
    channel, stepNumber, input.motion,
    input.include_meeting_cta ?? false,
    input.calendar_link,
    hasCustomInstructions ? [...legacy.global_rules, ...Object.values(legacy.step_instructions)].join(" ") : null,
  );

  // Generation hints: tactical guidance the AI can use or ignore
  const hints: string[] = [];
  if (input.motion === "inbound_response" && channel === "email") {
    hints.push("Open by acknowledging their inbound interest, then move toward a meeting");
  } else {
    if (stepNumber === 1) hints.push("Prove you know who they are in the first sentence");
    if (stepNumber === 2) hints.push("Reference previous email briefly, then pivot to a NEW angle");
    if (stepNumber === 3) hints.push("Lead with proof or a concrete result");
    if (stepNumber === 4) hints.push("No guilt, no urgency — direct yes/no question");
  }
  if (channel === "sms") hints.push("One sentence max. 160 chars.");
  if (channel === "whatsapp") hints.push("Casual, like a work friend texting. Max 50 words.");
  if (channel === "voice") hints.push("Talk track, not a script. 3 bullets max.");
  if (input.outbound_tone === "conversational") hints.push("Warm, relaxed, use contractions");
  if (input.outbound_tone === "assertive") hints.push("Confident, include specific offers, action-oriented CTA");
  if (input.outbound_tone === "consultative") hints.push("Trusted advisor positioning, diagnostic questions");

  return {
    channel,
    framework,
    objective,
    hard_rules: hardRules,
    generation_hints: hints,
    sequence_context: sequenceContext,
    personalization_context: {
      tone: input.outbound_tone || "direct",
      playbook_id: input.playbook_id || "general_sales",
      include_meeting_cta: input.include_meeting_cta ?? false,
      calendar_link: input.calendar_link || null,
    },
    max_word_count: maxWordCount,
    cta_type: ctaType,
    raw_custom_instructions: hasCustomInstructions
      ? [...legacy.global_rules, ...Object.values(legacy.step_instructions)].join("\n")
      : null,
  };
}

// ── Format for AI prompt injection ──────────────────────────────────
// Converts the structured instruction into a prompt block that
// ai_task can inject into its prompt assembly pipeline.

export function formatInstructionForPrompt(instruction: ResolvedInstruction): string {
  const parts: string[] = [];

  parts.push(`=== CAMPAIGN INSTRUCTION (STRUCTURED) ===`);
  parts.push(`Channel: ${instruction.channel}`);
  parts.push(`Framework: ${instruction.framework}`);
  parts.push(`Objective: ${instruction.objective}`);
  parts.push(`Sequence: Step ${instruction.sequence_context.step_number} of ${instruction.sequence_context.total_steps}`);
  parts.push(`Max words: ${instruction.max_word_count}`);
  parts.push(`CTA type: ${instruction.cta_type}`);

  if (instruction.sequence_context.has_reply) {
    parts.push(`⚠ Lead has replied — adjust tone accordingly`);
  }
  if (instruction.sequence_context.meeting_booked) {
    parts.push(`⚠ Meeting already booked — do not ask for another`);
  }
  if (instruction.sequence_context.days_since_last_touch !== null) {
    parts.push(`Days since last touch: ${instruction.sequence_context.days_since_last_touch}`);
  }
  if (instruction.sequence_context.prior_channels_used.length > 0) {
    parts.push(`Prior channels used: ${instruction.sequence_context.prior_channels_used.join(", ")}`);
  }

  if (instruction.hard_rules.length > 0) {
    parts.push(`\nHARD RULES (mandatory):`);
    for (const rule of instruction.hard_rules) {
      parts.push(`- ${rule}`);
    }
  }

  if (instruction.generation_hints.length > 0) {
    parts.push(`\nGENERATION HINTS:`);
    for (const hint of instruction.generation_hints) {
      parts.push(`- ${hint}`);
    }
  }

  if (instruction.raw_custom_instructions) {
    parts.push(`\nCAMPAIGN CUSTOM INSTRUCTIONS (user-provided, MANDATORY):`);
    parts.push(instruction.raw_custom_instructions);
  }

  parts.push(`=== END CAMPAIGN INSTRUCTION ===`);
  return parts.join("\n");
}
