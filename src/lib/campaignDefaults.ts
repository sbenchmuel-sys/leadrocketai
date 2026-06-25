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
  // The step's PRIOR step_number when editing an already-saved campaign, so the
  // reconciling write path can move this touch's generated copy / collateral
  // link to its new number (and drop them when the touch is removed). null/
  // undefined = a freshly added touch with no prior identity (no copy yet).
  // Unused by the new-campaign builder (every touch is new there).
  orig_step_number?: number | null;
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
    orig_step_number: null, // freshly added — no prior copy to carry forward
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
  const added = blankTouch(channel);
  next.splice(clamped, 0, added);
  // Inserting BEFORE the current first touch: the new touch becomes day 0
  // (normalizePlan forces the first gap to 0), so hand the new touch's gap to
  // the displaced old-first. Otherwise the two would collide on day 0 and the
  // rest of the schedule wouldn't shift out the way a mid-insert does.
  if (clamped === 0 && next.length > 1) {
    next[1] = { ...next[1], delay_days: added.delay_days };
  }
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

// ── Instruction shortcut: meeting-CTA intent (Unit 3) ───────────────
// A typed campaign instruction like "add the meeting link to every email" is a
// shortcut that ticks the per-step "Include a meeting link" boxes so the rep can
// see and fine-tune them. We act ONLY on clear, unambiguous "every/all emails"
// phrasing tied to a meeting concept. We deliberately DO NOT parse specific email
// numbers from free text ("emails 2 and 3") — those are what the per-step
// checkboxes are for. Conservative by design: an unclear or soft ask leaves every
// step null (today's default behavior — no email changes byte for byte).

export type MeetingCtaScope = "all_on" | "all_off" | "soft" | "none";

// Clear meeting / booking / calendar phrasing. Kept tight to avoid false positives
// — a bare "call" is too broad (cold calls, phone calls), so it's excluded.
const MEETING_CONCEPT_RE =
  /\b(?:meeting link|calendar link|booking link|meeting cta|book a (?:call|time|meeting|slot|chat)|schedule a (?:call|meeting|time|chat)|grab (?:some |a )?time|find a time|meeting|calendar|booking)\b/i;

// A universal quantifier over the email touches: "every email", "all emails",
// "each message", "every single email", "all/all the/all of the emails".
// AFFIRMATIVE form deliberately EXCLUDES "any": "add the link to ANY of the emails
// where it fits" is an ambiguous/conditional ask, not a clear "every email".
const ALL_EMAILS_AFFIRMATIVE_RE =
  /\b(?:every|each|all)\s+(?:single\s+|one\s+)?(?:of\s+)?(?:the\s+)?(?:e-?mails?|messages?|touches?)\b/i;
// In a NEGATED opt-out, "any" DOES read as universal ("no links in ANY emails" =
// "in all emails"), so the negated form additionally accepts "any".
const ALL_EMAILS_NEGATED_RE =
  /\b(?:every|each|all|any)\s+(?:single\s+|one\s+)?(?:of\s+)?(?:the\s+)?(?:e-?mails?|messages?|touches?)\b/i;

// Specific-email phrasing we must NOT act on structurally (the rep should use the
// checkboxes): "email 2", "emails 2 and 3", "step 3", "the second email",
// "first and third emails", "2nd email".
const SPECIFIC_EMAIL_RE =
  /\b(?:e-?mail|message|touch|step)s?\s*#?\s*\d+\b|\b(?:first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(?:and\s+(?:first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+)?(?:e-?mails?|messages?|touches?)\b/i;

// A NEGATED meeting-link ask ("don't add the meeting link", "no calendar link",
// "skip the booking link"). Mirrors the proven opt-out regexes in ai_task so the
// shortcut never FORCES links on when the rep explicitly opts out. Requires the
// meeting word paired with an unambiguous CTA noun so scheduling notes ("no
// meeting on Tuesday") don't trip it.
const NEGATED_MEETING_RE =
  /\b(?:no|skip|omit|exclude|without|remove|drop)\s+(?:the\s+|a\s+|any\s+)?(?:meeting|calendar|booking)s?\s+(?:link|cta|button|invite|url|request)s?\b|\b(?:don'?t|do\s+not|never)\s+(?:include|mention|add|push|attach|insert|use|put|place)\s+(?:the\s+|a\s+|any\s+)?(?:meeting|calendar|booking)s?\s+(?:link|cta|button|invite|url|request)s?\b/i;

/** Whether the instruction names specific emails by number/ordinal (→ checkboxes,
 *  not a structural shortcut). Exported for the optional UI hint and for tests. */
export function mentionsSpecificEmailSteps(instructions: string | null | undefined): boolean {
  return SPECIFIC_EMAIL_RE.test(instructions || "");
}

/**
 * Classify a campaign's custom instructions for meeting-CTA intent:
 *  - "all_on"  → clear "every/all emails" + a meeting concept, no specific numbers,
 *                affirmative ("add the meeting link to every email").
 *  - "all_off" → the SAME universal phrasing but NEGATED ("don't add the meeting
 *                link to every email") → tick every email OFF, honoring the opt-out.
 *  - "soft"    → a meeting concept but unscoped, or scoped to specific emails.
 *  - "none"    → no meeting concept at all.
 * Only "all_on"/"all_off" drive a structural change (see applyMeetingCtaIntent).
 */
export function detectMeetingCtaIntent(instructions: string | null | undefined): MeetingCtaScope {
  const text = (instructions || "").trim();
  if (!text || !MEETING_CONCEPT_RE.test(text)) return "none";
  // An EXPLICIT universal ask wins, even if the text also names specific emails.
  // (The default instructions carry a boilerplate "on the 2nd and 3rd emails…"
  // line; without this, adding "…to every email" would be misread as a
  // specific-email ask and the shortcut would silently do nothing.) A NEGATED
  // universal request is an explicit opt-out (and there "any emails" counts); an
  // AFFIRMATIVE force-on requires an unambiguous every/all (never a conditional "any").
  if (NEGATED_MEETING_RE.test(text)) {
    return ALL_EMAILS_NEGATED_RE.test(text) ? "all_off" : "soft";
  }
  if (ALL_EMAILS_AFFIRMATIVE_RE.test(text)) {
    return "all_on";
  }
  // No universal quantifier: naming specific emails (or any softer ask) is left to
  // the per-step checkboxes — no structural change.
  return "soft";
}

/**
 * Apply a universal meeting-CTA intent to the plan's EMAIL touches:
 *  - "all_on"  → tick every email ON (include_meeting_cta=true).
 *  - "all_off" → tick every email OFF (include_meeting_cta=false) — honors an
 *                explicit "don't add the meeting link to every email".
 *  - anything else → leave the plan untouched (email steps stay null → today's
 *    default). Non-email touches are never flagged (the meeting link is email-only).
 */
export function applyMeetingCtaIntent(plan: DraftStep[], scope: MeetingCtaScope): DraftStep[] {
  if (scope !== "all_on" && scope !== "all_off") return plan;
  const value = scope === "all_on";
  return plan.map((s) =>
    s.channel === "email" ? { ...s, include_meeting_cta: value } : s,
  );
}
