// ============================================
// STRUCTURED CAMPAIGN TYPES & CONSTRAINTS
// Shared between campaignResolver, ai_task, and automation-executor.
// ============================================

// ── Canonical channels ──────────────────────────────────────────────

export type CanonicalChannel = "email" | "whatsapp" | "sms" | "voice" | "meeting";

// ── Structured step config ──────────────────────────────────────────

export interface CampaignStepConfig {
  step_type: "intro" | "followup" | "value_add" | "breakup" | "nurture" | "re_engagement";
  channel: CanonicalChannel;
  objective: string;
  framework: string;
  max_words: number;
  max_words_with_instructions: number;  // expanded limit when custom instructions present
  cta_type: string;
  sequence_position: number;
  hard_rules: string[];
  active: boolean;
}

// ── Sequence context ────────────────────────────────────────────────

export interface SequenceContext {
  step_number: number;
  total_steps: number;
  prior_steps_sent: number;
  prior_channels_used: CanonicalChannel[];
  days_since_last_touch: number | null;
  has_reply: boolean;
  meeting_booked: boolean;
  recent_objections: string[];
  recent_signals: string[];
}

// ── Resolved instruction (output of the resolver) ───────────────────

export interface ResolvedInstruction {
  channel: CanonicalChannel;
  framework: string;
  objective: string;
  hard_rules: string[];
  generation_hints: string[];
  sequence_context: SequenceContext;
  personalization_context: {
    tone: string;
    playbook_id: string;
    include_meeting_cta: boolean;
    calendar_link: string | null;
  };
  max_word_count: number;
  cta_type: string;
  raw_custom_instructions: string | null;  // legacy compat
}

// ── Action key → step number mapping ────────────────────────────────
// Centralizes the regex-based extraction that was scattered across
// automation-executor and ai_task.

export const ACTION_KEY_TO_STEP: Record<string, number> = {
  send_pre_1: 1,
  send_pre_1_intro: 1,
  send_pre_2: 2,
  send_pre_2_followup: 2,
  send_pre_3: 3,
  send_pre_3_followup: 3,
  send_pre_4: 4,
  send_pre_4_breakup: 4,
  nurture_1: 1,
  nurture_2: 2,
  nurture_3: 3,
  nurture_4: 4,
  send_nurture_1: 1,
  send_nurture_2: 2,
  send_nurture_3: 3,
  send_nurture_4: 4,
};

// ── Channel × Step constraints ──────────────────────────────────────
// Defines per-channel, per-step word limits and hard rules.

interface StepConstraint {
  max_words: number;
  max_words_with_instructions: number;
  hard_rules: string[];
}

export const CHANNEL_STEP_CONSTRAINTS: Record<CanonicalChannel, Record<number, StepConstraint>> = {
  email: {
    1: {
      max_words: 75,
      max_words_with_instructions: 120,
      hard_rules: [
        "2 short paragraphs max",
        "First sentence proves you know who they are",
        "Last sentence is a question (CTA)",
        "No feature lists, no attachments, no calendar links unless instructed",
      ],
    },
    2: {
      max_words: 60,
      max_words_with_instructions: 90,
      hard_rules: [
        "Do NOT start with 'Just following up' / 'Checking in'",
        "Reference previous email briefly, then pivot to NEW angle",
        "One question only",
      ],
    },
    3: {
      max_words: 60,
      max_words_with_instructions: 100,
      hard_rules: [
        "Lead with one concrete insight or result",
        "The insight must relate to THEIR industry",
        "Different angle than previous emails",
      ],
    },
    4: {
      max_words: 40,
      max_words_with_instructions: 70,
      hard_rules: [
        "No guilt, no fake urgency",
        "Ask a direct yes/no question",
        "Leave the door open in one sentence",
      ],
    },
  },
  whatsapp: {
    1: { max_words: 50, max_words_with_instructions: 60, hard_rules: ["No formal sign-offs", "No signature blocks", "One emoji max", "No subject line"] },
    2: { max_words: 50, max_words_with_instructions: 60, hard_rules: ["Different from msg 1", "No sign-off"] },
    3: { max_words: 50, max_words_with_instructions: 60, hard_rules: ["Keep it light", "One proof point"] },
    4: { max_words: 40, max_words_with_instructions: 50, hard_rules: ["No pressure", "Direct close question"] },
  },
  sms: {
    1: { max_words: 25, max_words_with_instructions: 30, hard_rules: ["MAXIMUM 160 characters", "One sentence only", "No greeting beyond first name"] },
    2: { max_words: 25, max_words_with_instructions: 30, hard_rules: ["MAXIMUM 160 characters", "No sign-off"] },
    3: { max_words: 25, max_words_with_instructions: 30, hard_rules: ["MAXIMUM 160 characters", "Include a number"] },
    4: { max_words: 25, max_words_with_instructions: 30, hard_rules: ["MAXIMUM 160 characters", "No guilt"] },
  },
  voice: {
    1: { max_words: 60, max_words_with_instructions: 80, hard_rules: ["2-3 bullet points max", "Each speakable in under 8 seconds", "Natural language"] },
    2: { max_words: 60, max_words_with_instructions: 80, hard_rules: ["2-3 bullets", "No jargon"] },
    3: { max_words: 60, max_words_with_instructions: 80, hard_rules: ["3 bullets max"] },
    4: { max_words: 50, max_words_with_instructions: 70, hard_rules: ["2 bullets", "Professional"] },
  },
  meeting: {
    1: { max_words: 150, max_words_with_instructions: 200, hard_rules: ["Include agenda items", "Confirm logistics"] },
    2: { max_words: 100, max_words_with_instructions: 150, hard_rules: ["Brief reminder"] },
    3: { max_words: 100, max_words_with_instructions: 150, hard_rules: [] },
    4: { max_words: 100, max_words_with_instructions: 150, hard_rules: [] },
  },
};

// ── Default step configs (used when no explicit campaign exists) ────

export const DEFAULT_STEP_CONFIG: Record<number, CampaignStepConfig> = {
  1: {
    step_type: "intro",
    channel: "email",
    objective: "Get a reply by being specific and human",
    framework: "neutral_observation",
    max_words: 75,
    max_words_with_instructions: 120,
    cta_type: "question",
    sequence_position: 1,
    hard_rules: CHANNEL_STEP_CONSTRAINTS.email[1].hard_rules,
    active: true,
  },
  2: {
    step_type: "followup",
    channel: "email",
    objective: "Give them a new reason to reply — different angle",
    framework: "hypothesis",
    max_words: 60,
    max_words_with_instructions: 90,
    cta_type: "question",
    sequence_position: 2,
    hard_rules: CHANNEL_STEP_CONSTRAINTS.email[2].hard_rules,
    active: true,
  },
  3: {
    step_type: "value_add",
    channel: "email",
    objective: "Share proof or value — make it easy to say yes",
    framework: "value_add",
    max_words: 60,
    max_words_with_instructions: 100,
    cta_type: "soft_offer",
    sequence_position: 3,
    hard_rules: CHANNEL_STEP_CONSTRAINTS.email[3].hard_rules,
    active: true,
  },
  4: {
    step_type: "breakup",
    channel: "email",
    objective: "Close the loop respectfully",
    framework: "breakup",
    max_words: 40,
    max_words_with_instructions: 70,
    cta_type: "breakup_close",
    sequence_position: 4,
    hard_rules: CHANNEL_STEP_CONSTRAINTS.email[4].hard_rules,
    active: true,
  },
};

// ── Default CTA types per channel × step ────────────────────────────

export const CHANNEL_CTA_DEFAULTS: Record<CanonicalChannel, Record<number, string>> = {
  email: { 1: "question", 2: "question", 3: "soft_offer", 4: "breakup_close" },
  whatsapp: { 1: "question", 2: "question", 3: "question", 4: "breakup_close" },
  sms: { 1: "question", 2: "question", 3: "question", 4: "breakup_close" },
  voice: { 1: "question", 2: "question", 3: "question", 4: "breakup_close" },
  meeting: { 1: "meeting_request", 2: "meeting_request", 3: "meeting_request", 4: "timing_check" },
};
