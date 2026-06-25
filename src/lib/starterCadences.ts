// ============================================
// STARTER CADENCE LIBRARY
// A small set of ready-made cadences a rep can add with one click. Each one
// CLONES into a normal, editable DRAFT outreach owned by the rep's workspace
// via the existing createCampaignWithSteps() primitive — no new campaign infra.
//
// A starter is plain data: an ordered list of touches with a channel, an
// absolute day-offset, a step_type and a cta_type. The actual email COPY is not
// stored here — it is generated at review time from the existing prompt
// templates in supabase/functions/_shared/prompts.ts, exactly like a
// hand-built outreach. That is why createCampaignWithSteps NOT copying
// campaign_step_content is fine: there is no pre-written content to copy.
//
// IMPORTANT — `templateKey` is DOCUMENTATION ONLY. campaign_steps has no
// template column; the live send path picks the prompt from the touch's
// SEQUENCE POSITION + the lead's motion (see automation-executor/index.ts
// ~L826-851). The presets line their `step_type`s up so the intended template
// fires under that existing position/motion mapping — but nothing here forces a
// specific template. Treat templateKey as the author's intent, not a binding.
// ============================================

import type { CanonicalChannel } from "@/lib/channels";
import type { StepType } from "@/lib/campaignTypes";
import type {
  CreateCampaignInput,
  DraftCampaignStep,
} from "@/lib/campaignQueries";

// ── A single touch in a starter cadence ─────────────────────────────
export interface StarterTouch {
  /**
   * The ABSOLUTE day this touch lands on (first touch = day 0). Converted to
   * the per-touch `delay_days` gap (days since the previous touch) that
   * campaign_steps stores — see starterToDraftSteps.
   */
  day: number;
  channel: CanonicalChannel;
  step_type: StepType;
  cta_type: string;
  /** Documentation only — see file header. The prompt template this touch is
   *  meant to generate from at review time. */
  templateKey: string;
  /** Short, plain-language hint layered on top of the template. Not email copy. */
  custom_instructions: string;
}

export interface StarterCadence {
  /** Stable id used as the React key and the picker's selection token. */
  id: string;
  name: string;
  /** One-line plain-language summary of what the cadence DOES. */
  tagline: string;
  /**
   * One line: WHO a rep should enroll. The copy a starter generates is
   * motion/position-derived, so the name alone doesn't tell a rep who it's for —
   * this hint does. Shown on the card so the right people get the right cadence.
   */
  whoFor: string;
  /** A touch more detail under the tagline. */
  description: string;
  default_channel: CanonicalChannel;
  include_meeting_cta: boolean;
  global_instructions: string;
  touches: StarterTouch[];
}

// Reused, plain-language global guidance. Cold/Re-engage are email-only, so they
// carry their own short notes rather than the multi-channel default.
const MULTICHANNEL_INSTRUCTIONS = `- Emails: open with one line personalized to this person, then 2–3 lines about the offer. Keep it short and human.
- Use the text only if they haven't answered the earlier emails.
- On the later emails, offer something useful and suggest a quick call.
- Never over-promise, and always honor opt-outs.`;

const COLD_INSTRUCTIONS = `- Open each email with one line that shows you know who they are, then 2–3 lines on why you're reaching out.
- Each follow-up should bring a fresh angle — never "just checking in".
- Keep it short, human, and honest. Always honor opt-outs.`;

const REENGAGE_INSTRUCTIONS = `- These people have heard from us before — write like someone reconnecting, not a cold stranger.
- Reference the earlier relationship in one line, then give one new, genuine reason to talk now.
- Keep it warm and low-pressure. Always honor opt-outs.`;

// ── The library ─────────────────────────────────────────────────────
export const STARTER_CADENCES: StarterCadence[] = [
  {
    id: "inbound_intro",
    name: "Inbound Intro",
    tagline: "Reply fast, then follow up across email, call and text.",
    whoFor: "Leads that came in via your website, a form, or a referral.",
    description:
      "A 7-touch mix for warm or inbound leads: lead with a quick reply, then weave in calls and a text between follow-up emails over nine days.",
    default_channel: "email",
    include_meeting_cta: false,
    global_instructions: MULTICHANNEL_INSTRUCTIONS,
    touches: [
      {
        day: 0,
        channel: "email",
        step_type: "intro",
        cta_type: "question",
        templateKey: "inbound_intro",
        custom_instructions:
          "First reply. Acknowledge why they're a good fit, answer the obvious question, and end with one easy question.",
      },
      {
        day: 1,
        channel: "voice",
        step_type: "followup",
        cta_type: "question",
        templateKey: "cold_call_talking_points",
        custom_instructions:
          "Quick call — 2–3 talking points, nothing scripted. Leave a short voicemail if there's no answer.",
      },
      {
        day: 2,
        channel: "email",
        step_type: "followup",
        cta_type: "question",
        templateKey: "pre_email_2_followup",
        custom_instructions:
          "Reference the first email in one line, then a fresh angle. One question only.",
      },
      {
        day: 3,
        channel: "sms",
        step_type: "followup",
        cta_type: "question",
        templateKey: "sms_message",
        custom_instructions:
          "Short text, only because they haven't replied yet. One sentence, under 160 characters.",
      },
      {
        day: 5,
        channel: "email",
        step_type: "followup",
        cta_type: "question",
        templateKey: "pre_email_3_followup",
        custom_instructions:
          "Add one useful proof point and offer to send something relevant. One light question.",
      },
      {
        day: 6,
        channel: "voice",
        step_type: "followup",
        cta_type: "question",
        templateKey: "cold_call_talking_points",
        custom_instructions:
          "Second call attempt. Brief — reference the value you've already shared. Voicemail if no answer.",
      },
      {
        day: 9,
        channel: "email",
        step_type: "breakup",
        cta_type: "breakup_close",
        templateKey: "pre_email_4_breakup",
        custom_instructions:
          "Last email. No guilt, no fake urgency. Ask a direct yes/no question and leave the door open.",
      },
    ],
  },
  {
    id: "cold_outbound",
    name: "Cold Outbound",
    tagline: "A focused four-email cold sequence.",
    whoFor: "Cold prospects who've never heard from you before.",
    description:
      "Email-only: intro, two follow-ups, then a respectful breakup over twelve days. Stays behind every existing cold-send guardrail.",
    default_channel: "email",
    include_meeting_cta: false,
    global_instructions: COLD_INSTRUCTIONS,
    touches: [
      {
        day: 0,
        channel: "email",
        step_type: "intro",
        cta_type: "question",
        templateKey: "pre_email_1_intro",
        custom_instructions:
          "First email. One personalized opener, then 2–3 lines on the offer. End with a soft question. No attachments.",
      },
      {
        day: 3,
        channel: "email",
        step_type: "followup",
        cta_type: "question",
        templateKey: "pre_email_2_followup",
        custom_instructions:
          "Follow-up. Reference the first email in one line, then a fresh angle. One question only.",
      },
      {
        day: 7,
        channel: "email",
        step_type: "followup",
        cta_type: "question",
        templateKey: "pre_email_3_followup",
        custom_instructions:
          "Add a proof point or a new reason to reply. Keep it short and specific.",
      },
      {
        day: 12,
        channel: "email",
        step_type: "breakup",
        cta_type: "breakup_close",
        templateKey: "pre_email_4_breakup",
        custom_instructions:
          "Last email. No guilt, no fake urgency. Ask a direct yes/no question and leave the door open.",
      },
    ],
  },
  {
    id: "reengage",
    name: "Re-engage",
    tagline: "Reconnect with people who went quiet.",
    whoFor: "Past contacts who stalled or went dark and need a nudge.",
    description:
      "Three warm emails for past contacts: a soft check-in, a fresh-angle follow-up, then a gentle close over nine days.",
    default_channel: "email",
    include_meeting_cta: false,
    global_instructions: REENGAGE_INSTRUCTIONS,
    touches: [
      {
        day: 0,
        channel: "email",
        // Reuses the existing re_engagement step semantics (neutral-observation
        // opener, "soft check-in" objective) from _shared/campaignStepConfig.ts.
        // At send time, a lead on the re_engagement motion generates from the
        // re_engagement_intro template (_shared/prompts.ts) — copy is not rewritten here.
        step_type: "re_engagement",
        cta_type: "question",
        templateKey: "re_engagement_intro",
        custom_instructions:
          "Warm reconnect. Reference the earlier relationship in one line, then one new, genuine reason to talk now.",
      },
      {
        day: 4,
        channel: "email",
        step_type: "followup",
        cta_type: "question",
        templateKey: "pre_email_2_followup",
        custom_instructions:
          "Light follow-up. A different angle than the first note. One easy question.",
      },
      {
        day: 9,
        channel: "email",
        step_type: "breakup",
        cta_type: "breakup_close",
        templateKey: "pre_email_4_breakup",
        custom_instructions:
          "Gentle close. No pressure. Ask a direct yes/no question and leave the door open for later.",
      },
    ],
  },
];

// ── Conversion helpers (pure) ───────────────────────────────────────

/** Look a cadence up by id. */
export function getStarterCadence(id: string): StarterCadence | undefined {
  return STARTER_CADENCES.find((c) => c.id === id);
}

/** Does this cadence include an SMS touch? Drives the "needs SMS enabled" note. */
export function cadenceUsesSms(cadence: StarterCadence): boolean {
  return cadence.touches.some((t) => t.channel === "sms");
}

/**
 * Convert a starter cadence's touches into the DraftCampaignStep[] that
 * createCampaignWithSteps expects. The key transform is day-offset → gap:
 * campaign_steps stores `delay_days` as the wait since the PREVIOUS touch, but
 * starters are authored with absolute day-offsets for readability. The first
 * touch is always day 0. Every touch is kept (the SMS touch is never dropped) —
 * sending it later just requires workspaces.sms_enabled.
 */
export function starterToDraftSteps(cadence: StarterCadence): DraftCampaignStep[] {
  return cadence.touches.map((t, i) => ({
    step_number: i + 1,
    step_type: t.step_type,
    channel: t.channel,
    delay_days: i === 0 ? 0 : t.day - cadence.touches[i - 1].day,
    cta_type: t.cta_type,
    custom_instructions: t.custom_instructions,
    active: true,
    variant_group: null,
  }));
}

/**
 * Build the full createCampaignWithSteps input for cloning a starter into a new
 * DRAFT outreach owned by `workspaceId`. send_mode is intentionally NOT set —
 * it falls to the DB default 'review', so a cloned starter always ships in
 * manual/review mode. The rep flips it to auto-send later via the CampaignDetail
 * "Sending" card.
 */
export function starterToCreateInput(
  cadence: StarterCadence,
  workspaceId: string,
): CreateCampaignInput {
  return {
    workspace_id: workspaceId,
    name: cadence.name,
    campaign_type: "general",
    default_channel: cadence.default_channel,
    include_meeting_cta: cadence.include_meeting_cta,
    global_instructions: cadence.global_instructions,
    knowledge_ref: null,
    steps: starterToDraftSteps(cadence),
  };
}
