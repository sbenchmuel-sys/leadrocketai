// ============================================
// CAMPAIGN DEFAULTS (Outreach Unit A)
// The finished-by-default touch plan and the editable instruction
// prompt that pre-fills a new outreach so it works out of the box.
// Content here is the SKELETON only — AI message generation lands in
// Unit B. These are the defaults a rep sees, never a blank builder.
//
// The plan interleaves email / call / SMS with three manual LinkedIn touches
// (a connection request, a react-to-their-post nudge, and a follow-up message).
// LinkedIn touches are ALWAYS manual — authored here, run by hand from the Queue.
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
  // Per-step "Include a meeting link" override (email touches only).
  // null = inherit the campaign-level default; true/false = force on/off.
  include_meeting_cta?: boolean | null;
}

// ── The recommended 9-touch plan, presented as FINISHED ─────────────
// Three of the nine touches are manual LinkedIn touches (connection request,
// react-to-their-post, follow-up message) woven INTO the plan — not bolted on.
// `preferredChannel` says which channel this touch wants; if the rep didn't pick
// that channel it falls back to email so the plan always stays 9 touches and never
// stalls. The custom_instructions are written goal-first (not channel-mechanic-
// first) so a LinkedIn touch that falls back to email still reads as a sensible email.
interface TouchTemplate {
  step_type: StepType;
  preferredChannel: CanonicalChannel;
  delay_days: number;
  cta_type: string;
  custom_instructions: string;
}

const NINE_TOUCH_TEMPLATE: TouchTemplate[] = [
  {
    // 1 · Email — first message (day 0)
    step_type: "intro",
    preferredChannel: "email",
    delay_days: 0,
    cta_type: "question",
    custom_instructions:
      "First email. Open with one line that shows you know who they are, then 2–3 lines on the offer from the knowledge file. End with a soft question. No attachments.",
  },
  {
    // 2 · LinkedIn — connection request (short, no-pressure note). Manual touch.
    step_type: "intro",
    preferredChannel: "linkedin",
    delay_days: 1,
    cta_type: "question",
    custom_instructions:
      "Open a relationship with a short, no-pressure note that gives a genuine reason to connect. No pitch, no offer — just a real human reason to be in touch.",
  },
  {
    // 3 · Email — follow-up
    step_type: "followup",
    preferredChannel: "email",
    delay_days: 2,
    cta_type: "question",
    custom_instructions:
      "Follow-up. Reference the first email in one line, then a fresh angle. One question only. Don't say \"just checking in.\"",
  },
  {
    // 4 · Call
    step_type: "followup",
    preferredChannel: "voice",
    delay_days: 2,
    cta_type: "question",
    custom_instructions:
      "Quick call. 2–3 talking points, nothing scripted. If no one answers, leave a short voicemail and the next email will follow up on it.",
  },
  {
    // 5 · LinkedIn — react to their post (engage with something they recently shared). Manual touch.
    step_type: "value_add",
    preferredChannel: "linkedin",
    delay_days: 2,
    cta_type: "soft_offer",
    custom_instructions:
      "Engage with something the prospect recently shared — react to their latest post or update with a short, specific, genuine comment. No pitch.",
  },
  {
    // 6 · Text — only because they haven't replied yet
    step_type: "followup",
    preferredChannel: "sms",
    delay_days: 2,
    cta_type: "question",
    custom_instructions:
      "Short text, only because they haven't replied yet. One sentence, under 160 characters, no greeting beyond their first name.",
  },
  {
    // 7 · LinkedIn — follow-up message (friendly nudge, one light question). Manual touch.
    step_type: "followup",
    preferredChannel: "linkedin",
    delay_days: 3,
    cta_type: "question",
    custom_instructions:
      "Friendly follow-up that adds one relevant insight and ends with a single light question. No hard pitch.",
  },
  {
    // 8 · Call — second attempt
    step_type: "followup",
    preferredChannel: "voice",
    delay_days: 3,
    cta_type: "question",
    custom_instructions:
      "Second call attempt. Brief — reference the value you've already shared. Voicemail if there's no answer.",
  },
  {
    // 9 · Email — breakup
    step_type: "breakup",
    preferredChannel: "email",
    delay_days: 4,
    cta_type: "breakup_close",
    custom_instructions:
      "Last email. No guilt, no fake urgency. Ask a direct yes/no question and leave the door open in one sentence.",
  },
];

/**
 * Build the default draft plan for the channels the rep selected.
 * Email is always available; any touch whose preferred channel wasn't
 * selected (e.g. LinkedIn) falls back to email so the plan is always a
 * full set of touches.
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
  linkedin: "LinkedIn",
};

/** "Email", "Call", "Text" — the word a rep understands. */
export function touchVerb(channel: CanonicalChannel): string {
  return STEP_VERB[channel] ?? "Email";
}

/**
 * Plain-English row label for the plan review. LinkedIn is the one channel that
 * carries three distinct manual touches, so it reads by its step_type — "Connect
 * on LinkedIn" / "React to their post" / "LinkedIn message" — instead of three
 * identical "LinkedIn" rows. Every other channel keeps its plain channel verb.
 */
export function touchLabel(channel: CanonicalChannel, stepType?: StepType): string {
  if (channel === "linkedin") {
    switch (stepType) {
      case "intro":
        return "Connect on LinkedIn";
      case "value_add":
        return "React to their post";
      default:
        return "LinkedIn message"; // followup / anything else
    }
  }
  return touchVerb(channel);
}

/** Cumulative day each touch lands on, from the per-touch gaps. */
export function cumulativeDays(steps: { delay_days: number }[]): number[] {
  let running = 0;
  return steps.map((s) => {
    running += s.delay_days;
    return running;
  });
}

// ── Cadence touch editor — pure plan mutations ──────────────────────
// The editor only lets a rep add/switch between the three plain channels they
// understand: an email, a call, or a text. (LinkedIn touches come from the
// default plan and are reordered, never authored here — calls/texts are manual
// touches and adding them never routes them into the auto-send path, which
// filters to email.)

/** A channel a rep can add or switch a touch to, with its plain-English verb. */
export interface EditableChannelOption {
  channel: CanonicalChannel;
  label: string;
}

export const EDITABLE_CHANNELS: EditableChannelOption[] = [
  { channel: "email", label: "email" },
  { channel: "voice", label: "call" },
  { channel: "sms", label: "text" },
];

// Default gap (days after the previous touch) for a freshly added touch.
const NEW_TOUCH_GAP = 2;

/**
 * A touch needs SMS turned on for the workspace before it can run. The editor
 * FLAGS such a step inline rather than dropping it — the rep keeps the step and
 * is told to enable texting in Settings.
 */
export function stepNeedsSmsSetup(
  step: { channel: CanonicalChannel },
  smsEnabled: boolean,
): boolean {
  return step.channel === "sms" && !smsEnabled;
}

/** Plain-English intent for an EMAIL touch, derived from its position. */
export function emailIntent(stepType: StepType): string {
  switch (stepType) {
    case "intro":
      return "first message";
    case "breakup":
      return "last message";
    default:
      return "follow-up";
  }
}

/**
 * Re-derive the position-dependent fields after any structural change so the
 * plan stays coherent:
 *  - step_number renumbered 1..N (no gaps),
 *  - the first touch always lands on day 0 (its gap is forced to 0 — the first
 *    message goes out right away and its delay control is disabled),
 *  - EMAIL step_type/cta_type follow the email's POSITION among the emails
 *    (first email → intro, last email → breakup, the rest → follow-up). The
 *    live template is chosen at send time by sequence position, so keeping
 *    step_type aligned with position keeps the plain-language intent honest and
 *    the right template firing. Non-email touches keep their authored type.
 */
export function normalizePlan(plan: DraftStep[]): DraftStep[] {
  const emailIndexes = plan
    .map((s, i) => (s.channel === "email" ? i : -1))
    .filter((i) => i >= 0);

  return plan.map((s, i) => {
    const base: DraftStep = {
      ...s,
      step_number: i + 1,
      delay_days: i === 0 ? 0 : s.delay_days,
    };
    if (s.channel !== "email") return base;

    const ord = emailIndexes.indexOf(i);
    const isFirstEmail = ord === 0;
    const isLastEmail = ord === emailIndexes.length - 1;
    const step_type: StepType = isFirstEmail
      ? "intro"
      : isLastEmail
        ? "breakup"
        : "followup";
    return {
      ...base,
      step_type,
      cta_type: step_type === "breakup" ? "breakup_close" : "question",
    };
  });
}

/** A blank touch for a newly added channel, before normalization. */
function blankTouch(channel: CanonicalChannel): DraftStep {
  return {
    step_number: 0, // set by normalizePlan
    step_type: "followup", // re-derived for emails by normalizePlan
    channel,
    delay_days: NEW_TOUCH_GAP,
    cta_type: "question",
    custom_instructions: "",
    active: true,
    include_meeting_cta: null,
  };
}

/**
 * Insert a new touch of `channel` so it becomes step number `atIndex` (0-based
 * slot). `atIndex >= plan.length` appends at the end. Later touches keep their
 * gaps, so adding a step pushes everything after it out by the new touch's gap —
 * the intuitive "I added a step, the rest moves later."
 */
export function insertStep(
  plan: DraftStep[],
  atIndex: number,
  channel: CanonicalChannel,
): DraftStep[] {
  const clamped = Math.max(0, Math.min(atIndex, plan.length));
  const next = [...plan];
  next.splice(clamped, 0, blankTouch(channel));
  return normalizePlan(next);
}

/**
 * Remove the touch at `index`. To keep the OVERALL schedule intact, the removed
 * touch's gap rolls into the touch that follows it — so later touches land on
 * the same days they did before, instead of all sliding earlier by accident.
 * Always keeps at least one touch.
 */
export function removeStep(plan: DraftStep[], index: number): DraftStep[] {
  if (plan.length <= 1 || index < 0 || index >= plan.length) return plan;
  const removedGap = plan[index].delay_days;
  const next = plan.filter((_, i) => i !== index);
  // The step that followed the removed one now sits at `index` in `next`.
  // Roll the removed gap into it so its absolute landing day is unchanged.
  // (Skipped when removing the first or last touch — no follower to absorb it,
  // and the new first touch is forced to day 0 by normalizePlan anyway.)
  if (index > 0 && index < next.length) {
    next[index] = { ...next[index], delay_days: next[index].delay_days + removedGap };
  }
  return normalizePlan(next);
}

/**
 * Move the touch at `index` one slot in `dir` (-1 up / +1 down). The per-slot
 * gaps stay put and only the touches swap between slots, so the schedule rhythm
 * (the day each slot lands on) is unchanged — reordering message types never
 * shifts the overall timing.
 */
export function moveStep(plan: DraftStep[], index: number, dir: -1 | 1): DraftStep[] {
  const j = index + dir;
  if (j < 0 || j >= plan.length) return plan;
  const next = [...plan];
  const a = next[index];
  const b = next[j];
  next[index] = { ...b, delay_days: a.delay_days };
  next[j] = { ...a, delay_days: b.delay_days };
  return normalizePlan(next);
}

/**
 * Change an existing touch's channel (e.g. turn an email into a call). Leaving
 * email clears the per-step meeting-link flag, since it only applies to emails.
 */
export function changeStepChannel(
  plan: DraftStep[],
  index: number,
  channel: CanonicalChannel,
): DraftStep[] {
  const next = plan.map((s, i) =>
    i === index
      ? {
          ...s,
          channel,
          include_meeting_cta: channel === "email" ? s.include_meeting_cta ?? null : null,
        }
      : s,
  );
  return normalizePlan(next);
}

/** Set a gap (days after the previous touch) on the touch at `index`. */
export function setStepGap(plan: DraftStep[], index: number, days: number): DraftStep[] {
  const next = plan.map((s, i) =>
    i === index ? { ...s, delay_days: Math.max(0, Math.round(days)) } : s,
  );
  return normalizePlan(next);
}

/** Toggle the per-step "Include a meeting link" flag (email touches only). */
export function setStepMeetingCta(
  plan: DraftStep[],
  index: number,
  value: boolean,
): DraftStep[] {
  return plan.map((s, i) =>
    i === index && s.channel === "email" ? { ...s, include_meeting_cta: value } : s,
  );
}
