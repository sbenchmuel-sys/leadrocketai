// ============================================
// CAMPAIGN DEFAULTS (Outreach Unit A)
// The finished-by-default 9-touch plan and the editable instruction
// prompt that pre-fills a new outreach so it works out of the box.
// Content here is the SKELETON only — AI message generation lands in
// Unit B. These are the defaults a rep sees, never a blank builder.
// ============================================

import type { CanonicalChannel } from "@/lib/channels";
import type { StepType } from "@/lib/campaignTypes";

// ── Default campaign-level instructions ─────────────────────────────
// Pre-filled into campaigns.global_instructions. Fully editable by the
// rep (tucked behind an "Edit instructions" expander).
export const DEFAULT_GLOBAL_INSTRUCTIONS = `- Emails: open with one line personalized to this lead's context, then 2–3 lines about the offer drawn from the campaign knowledge file. Keep it short and human.
- Use SMS only if the prospect hasn't answered earlier touches.
- On the 2nd and 3rd emails, offer to send a one-pager relevant to the prospect's industry and suggest a quick meeting.
- Stay grounded in the knowledge file, never over-promise, and always honor opt-outs.`;

// ── A single touch in the default plan ──────────────────────────────
export interface DraftStep {
  step_number: number;
  step_type: StepType;
  channel: CanonicalChannel;
  // Days to wait after the PREVIOUS touch (gap). Touch 1 is day 0.
  delay_days: number;
  cta_type: string;
  custom_instructions: string;
  active: boolean;
}

// ── The recommended 9-touch plan, presented as FINISHED ─────────────
// `preferredChannel` says which channel this touch wants; if the rep
// didn't pick that channel it falls back to email so the plan always
// stays 9 touches and never stalls.
interface TouchTemplate {
  step_type: StepType;
  preferredChannel: CanonicalChannel;
  delay_days: number;
  cta_type: string;
  custom_instructions: string;
}

const NINE_TOUCH_TEMPLATE: TouchTemplate[] = [
  {
    step_type: "intro",
    preferredChannel: "email",
    delay_days: 0,
    cta_type: "question",
    custom_instructions:
      "First email. Open with one line that shows you know who they are, then 2–3 lines on the offer from the knowledge file. End with a soft question. No attachments.",
  },
  {
    step_type: "followup",
    preferredChannel: "email",
    delay_days: 3,
    cta_type: "question",
    custom_instructions:
      "Follow-up. Reference the first email in one line, then a fresh angle. One question only. Don't say \"just checking in.\"",
  },
  {
    step_type: "followup",
    preferredChannel: "voice",
    delay_days: 2,
    cta_type: "question",
    custom_instructions:
      "Quick call. 2–3 talking points, nothing scripted. If no one answers, leave a short voicemail and the next email will follow up on it.",
  },
  {
    step_type: "value_add",
    preferredChannel: "email",
    delay_days: 3,
    cta_type: "soft_offer",
    custom_instructions:
      "Value email. Offer to send a one-pager relevant to their industry and suggest a quick meeting. Keep it generous, not pushy.",
  },
  {
    step_type: "followup",
    preferredChannel: "sms",
    delay_days: 2,
    cta_type: "question",
    custom_instructions:
      "Short text, only because they haven't replied yet. One sentence, under 160 characters, no greeting beyond their first name.",
  },
  {
    step_type: "value_add",
    preferredChannel: "email",
    delay_days: 4,
    cta_type: "soft_offer",
    custom_instructions:
      "Second value email. Lead with one concrete result or proof point relevant to their industry, then suggest a quick meeting.",
  },
  {
    step_type: "followup",
    preferredChannel: "voice",
    delay_days: 3,
    cta_type: "question",
    custom_instructions:
      "Second call attempt. Brief — reference the value you've already shared. Voicemail if there's no answer.",
  },
  {
    step_type: "followup",
    preferredChannel: "email",
    delay_days: 4,
    cta_type: "question",
    custom_instructions:
      "Light check-in. A new angle, human tone, one question. No pressure.",
  },
  {
    step_type: "breakup",
    preferredChannel: "email",
    delay_days: 5,
    cta_type: "breakup_close",
    custom_instructions:
      "Last email. No guilt, no fake urgency. Ask a direct yes/no question and leave the door open in one sentence.",
  },
];

/**
 * Build the default 9-touch draft plan for the channels the rep selected.
 * Email is always available; any touch whose preferred channel wasn't
 * selected falls back to email so the plan is always a full 9 touches.
 */
export function buildDefaultPlan(selectedChannels: CanonicalChannel[]): DraftStep[] {
  const enabled = new Set<CanonicalChannel>(["email", ...selectedChannels]);
  return NINE_TOUCH_TEMPLATE.map((t, i) => {
    const channel = enabled.has(t.preferredChannel) ? t.preferredChannel : "email";
    return {
      step_number: i + 1,
      step_type: t.step_type,
      channel,
      delay_days: t.delay_days,
      cta_type: t.cta_type,
      custom_instructions: t.custom_instructions,
      active: true,
    };
  });
}

// ── Plain-language helpers for the read-only script view ────────────

const STEP_VERB: Record<CanonicalChannel, string> = {
  email: "Email",
  voice: "Call",
  sms: "Text",
  whatsapp: "WhatsApp",
  meeting: "Meeting",
};

/** "Email", "Call", "Text" — the word a rep understands. */
export function touchVerb(channel: CanonicalChannel): string {
  return STEP_VERB[channel] ?? "Email";
}

/** Cumulative day each touch lands on, from the per-touch gaps. */
export function cumulativeDays(steps: { delay_days: number }[]): number[] {
  let running = 0;
  return steps.map((s) => {
    running += s.delay_days;
    return running;
  });
}
