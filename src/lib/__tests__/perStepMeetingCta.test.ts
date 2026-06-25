// ============================================================================
// PER-STEP MEETING CTA (Outreach Unit 3) — resolver decision + instruction shortcut
//
// The per-step source of truth is campaign_steps.include_meeting_cta. This suite
// covers the RESOLVER decision (meeting_cta_enabled + the force hard rule + the
// inbound CTA gating) and the typed-instruction shortcut. The per-rep, send-time
// link injection for cold campaigns is covered in the Deno test
// (supabase/functions/_shared/campaignMeetingCta.test.ts) because that's where it
// lives — the link is NEVER baked into shared authored content.
// ============================================================================

import { describe, it, expect } from "vitest";

// Server resolver (esm.sh-free, importable by vitest).
import {
  resolveCampaignInstruction,
  resolveStepMeetingCta,
  formatInstructionForPrompt,
} from "../../../supabase/functions/_shared/campaignResolver";

// Client mirror (parity).
import { resolveStepMeetingCta as clientResolveStepMeetingCta } from "@/lib/campaignResolver";

import {
  buildDefaultPlan,
  setStepMeetingCta,
  moveStep,
  detectMeetingCtaIntent,
  applyMeetingCtaIntent,
  mentionsSpecificEmailSteps,
  type DraftStep,
} from "@/lib/campaignDefaults";

import { draftStepToRow } from "@/lib/campaignQueries";
import { previewMeetingLink, appendMeetingCtaLocal } from "@/lib/outreachQueue";

const REP_LINK = "https://cal.example.com/rita";

function emailCampaign(flags: Array<boolean | null>) {
  return {
    id: "camp-1",
    workspace_id: "ws-1",
    motion: "outbound_prospecting",
    default_channel: "email",
    include_meeting_cta: false,
    global_instructions: null,
    knowledge_document_id: null,
    steps: flags.map((flag, i) => ({
      step_number: i + 1,
      step_type: i === 0 ? "intro" : i === flags.length - 1 ? "breakup" : "followup",
      channel: "email",
      framework: null,
      objective: null,
      cta_type: "question",
      max_word_count: null,
      hard_rules: [],
      generation_hints: [],
      custom_instructions: null,
      delay_days: i === 0 ? 0 : 2,
      active: true,
      variant_group: null,
      include_meeting_cta: flag,
    })),
  } as any;
}

// Resolve one step and report the resolver's decision.
function step(campaign: any, stepNo: number, calendarLink: string | null = REP_LINK, opts: any = {}) {
  const instruction = resolveCampaignInstruction({
    lead_id: "lead-1",
    action_key: `send_pre_${stepNo}`,
    motion: opts.motion || "outbound_prospecting",
    structured_campaign: campaign,
    calendar_link: calendarLink,
    meeting_booked: opts.meeting_booked,
  });
  return {
    instruction,
    enabled: instruction.meeting_cta_enabled,
    forced: instruction.hard_rules.some((r) => /meeting booking link/i.test(r)),
  };
}

// ── resolveStepMeetingCta (the tri-state collapse) ──────────────────────────

describe("resolveStepMeetingCta", () => {
  it("true → force_on, false → off, null/undefined → default", () => {
    expect(resolveStepMeetingCta(true)).toBe("force_on");
    expect(resolveStepMeetingCta(false)).toBe("off");
    expect(resolveStepMeetingCta(null)).toBe("default");
    expect(resolveStepMeetingCta(undefined)).toBe("default");
  });

  it("client mirror is identical to the server", () => {
    for (const v of [true, false, null, undefined] as const) {
      expect(clientResolveStepMeetingCta(v)).toBe(resolveStepMeetingCta(v));
    }
  });
});

// ── (a) per-step flags select exactly which emails are ON ───────────────────

describe("(a) per-step flags drive the per-step decision", () => {
  const campaign = emailCampaign([false, true, true, false]);

  it("only emails 2 and 3 are enabled and forced; 1 and 4 are off", () => {
    expect(step(campaign, 1).enabled).toBe(false);
    expect(step(campaign, 2).enabled).toBe(true);
    expect(step(campaign, 2).forced).toBe(true);
    expect(step(campaign, 3).enabled).toBe(true);
    expect(step(campaign, 3).forced).toBe(true);
    expect(step(campaign, 4).enabled).toBe(false);
    expect(step(campaign, 1).forced).toBe(false);
    expect(step(campaign, 4).forced).toBe(false);
  });
});

// ── every vs none flagged ───────────────────────────────────────────────────

describe("every vs none flagged", () => {
  it("every ON → all enabled + forced", () => {
    const c = emailCampaign([true, true, true, true]);
    for (let s = 1; s <= 4; s++) {
      expect(step(c, s).enabled).toBe(true);
      expect(step(c, s).forced).toBe(true);
    }
  });
  it("every OFF → none enabled, none forced", () => {
    const c = emailCampaign([false, false, false, false]);
    for (let s = 1; s <= 4; s++) {
      expect(step(c, s).enabled).toBe(false);
      expect(step(c, s).forced).toBe(false);
    }
  });
});

// ── (d) null preserves today (regeneration path byte-unchanged) ─────────────

describe("(d) null flags keep the regeneration path byte-unchanged", () => {
  const campaign = emailCampaign([null, null, null, null]);
  it("meeting_cta_enabled stays true and NO force rule is added for null steps", () => {
    for (let s = 1; s <= 4; s++) {
      expect(step(campaign, s).enabled).toBe(true);
      expect(step(campaign, s).forced).toBe(false); // the only hard_rules mutation — absent ⇒ unchanged block
    }
  });
  it("legacy path (no structured campaign) keeps meeting_cta_enabled = true", () => {
    const legacy = resolveCampaignInstruction({
      lead_id: "l", action_key: "send_pre_2", motion: "outbound_prospecting", calendar_link: REP_LINK,
    });
    expect(legacy.meeting_cta_enabled).toBe(true);
  });
});

// ── (c) no calendar link → never forces (nothing to force) ──────────────────

describe("(c) no calendar link → CTA omitted, no force rule", () => {
  it("a flagged step with no link is enabled but not forced (no broken link demand)", () => {
    const campaign = emailCampaign([true, true, true, true]);
    const r = step(campaign, 2, null);
    expect(r.forced).toBe(false);
  });
});

// ── non-email step flagged → ignored ────────────────────────────────────────

describe("a non-email step flagged is ignored", () => {
  it("a voice step with include_meeting_cta=true is never enabled-off nor forced", () => {
    const campaign = emailCampaign([null, true, null, null]);
    campaign.steps[1].channel = "voice";
    const instruction = resolveCampaignInstruction({
      lead_id: "l", action_key: "send_pre_2", motion: "outbound_prospecting",
      channel: "voice", structured_campaign: campaign, calendar_link: REP_LINK,
    });
    expect(instruction.meeting_cta_enabled).toBe(true); // not gated off (email-only)
    expect(instruction.hard_rules.some((r) => /meeting booking link/i.test(r))).toBe(false);
  });
});

// ── (f) meeting already booked suppresses the forced ask ────────────────────

describe("(f) meeting already booked", () => {
  const campaign = emailCampaign([true, true, true, true]);
  it("warns the model not to ask again AND drops the force rule when booked", () => {
    const booked = step(campaign, 2, REP_LINK, { meeting_booked: true });
    const notBooked = step(campaign, 2, REP_LINK, { meeting_booked: false });
    expect(formatInstructionForPrompt(booked.instruction)).toMatch(/Meeting already booked/i);
    expect(notBooked.forced).toBe(true);
    expect(booked.forced).toBe(false); // no contradictory "include the link" rule
  });
});

// ── inbound: explicit OFF never leaks the URL into the structured block ──────

describe("inbound step explicitly OFF withholds the URL", () => {
  function inbound(flag: boolean | null) {
    return resolveCampaignInstruction({
      lead_id: "l", action_key: "send_pre_1", motion: "inbound_response",
      structured_campaign: emailCampaign([flag]), calendar_link: REP_LINK,
    });
  }
  it("OFF → meeting_request cta_type, no URL in the block, rule forbids a link", () => {
    const off = inbound(false);
    expect(off.meeting_cta_enabled).toBe(false);
    expect(off.cta_type).toBe("meeting_request");
    expect(formatInstructionForPrompt(off)).not.toContain(REP_LINK);
    expect(off.hard_rules.some((r) => /do NOT include a booking link/i.test(r))).toBe(true);
  });
  it("null (default) inbound still embeds the booking link — unchanged", () => {
    const on = inbound(null);
    expect(on.cta_type).toBe(`meeting_booking:${REP_LINK}`);
    expect(formatInstructionForPrompt(on)).toContain(REP_LINK);
  });
});

// ── reorder keeps the flag with the right email ─────────────────────────────

describe("reorder keeps the flag with the right email", () => {
  it("the flag follows the email object through a move, not its slot", () => {
    let plan = buildDefaultPlan(["email"]);
    const idx = plan.findIndex((s) => s.channel === "email");
    plan = setStepMeetingCta(plan, idx, true);
    const moved = moveStep(plan, idx, 1);
    const flagged = moved.filter((s) => s.include_meeting_cta === true);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].channel).toBe("email");
  });
});

// ── (b) instruction shortcut ────────────────────────────────────────────────

describe("(b) instruction shortcut", () => {
  it("\"add the meeting CTA to every email\" → all_on, ticks every email", () => {
    const plan = buildDefaultPlan(["email", "voice", "sms"]);
    expect(detectMeetingCtaIntent("Please add the meeting CTA to every email.")).toBe("all_on");
    const applied = applyMeetingCtaIntent(plan, "all_on");
    for (const s of applied) {
      if (s.channel === "email") expect(s.include_meeting_cta).toBe(true);
      else expect(s.include_meeting_cta ?? null).toBeNull();
    }
  });

  it("a NEGATED universal ask → all_off (ticks every email off), incl. plurals", () => {
    for (const phrase of [
      "Don't add the meeting link to every email.",
      "Do not include a calendar link in any of the emails.",
      "No booking links on every email please.", // plural noun (Codex P2)
      "Don't add meeting links to all the emails.", // plural noun (Codex P2)
    ]) {
      expect(detectMeetingCtaIntent(phrase)).toBe("all_off");
    }
    const plan = buildDefaultPlan(["email", "voice"]);
    const applied = applyMeetingCtaIntent(plan, "all_off");
    for (const s of applied) {
      if (s.channel === "email") expect(s.include_meeting_cta).toBe(false);
      else expect(s.include_meeting_cta ?? null).toBeNull();
    }
  });

  it("an explicit 'every email' add OVERRIDES default-instruction step mentions (Codex P2)", () => {
    // The default instructions carry "On the 2nd and 3rd emails ... suggest a quick
    // meeting"; adding an every-email ask must still win.
    const withDefault =
      "On the 2nd and 3rd emails, offer a one-pager and suggest a quick meeting. Also add the meeting link to every email.";
    expect(detectMeetingCtaIntent(withDefault)).toBe("all_on");
  });

  it("a scheduling note ('no meeting on Tuesday') is not a negated opt-out", () => {
    expect(detectMeetingCtaIntent("Add the meeting link to every email, but no meeting on Tuesday."))
      .toBe("all_on");
  });

  it("affirmative ambiguous 'any of the emails' stays soft, but negated 'any' opts out (Codex P2)", () => {
    // "any ... where it fits" is conditional, NOT a clear "every email".
    expect(detectMeetingCtaIntent("Add the meeting link to any of the emails where it fits.")).toBe("soft");
    // but a negated "any" is still a universal opt-out.
    expect(detectMeetingCtaIntent("Don't put a calendar link on any of the emails.")).toBe("all_off");
  });

  it("naming specific emails (no universal ask) is left to the checkboxes", () => {
    expect(mentionsSpecificEmailSteps("Add the calendar link to emails 2 and 3")).toBe(true);
    expect(detectMeetingCtaIntent("Add the calendar link to emails 2 and 3")).toBe("soft");
    expect(detectMeetingCtaIntent("Put a booking link on the second email")).toBe("soft");
  });

  it("no meeting concept → none; default instructions alone never trigger a universal", () => {
    expect(detectMeetingCtaIntent("Keep it short and personal, mention our pricing.")).toBe("none");
    expect(detectMeetingCtaIntent("")).toBe("none");
    expect(
      detectMeetingCtaIntent("On the 2nd and 3rd emails, offer a one-pager and suggest a quick meeting."),
    ).toBe("soft");
  });

  it("soft/none scopes never change the plan", () => {
    const plan = buildDefaultPlan(["email"]);
    for (const scope of ["soft", "none"] as const) {
      expect(applyMeetingCtaIntent(plan, scope).every((s) => (s.include_meeting_cta ?? null) === null)).toBe(true);
    }
  });
});

// ── review preview: visible + editable + per-rep, no cross-rep leak ─────────

describe("review-mode preview meeting link", () => {
  const ME = "rep-me";
  const base = { channel: "email", currentUserId: ME, myCalendarLink: REP_LINK };

  it("force_on + my own lead + my link → show my link", () => {
    expect(previewMeetingLink({ ...base, leadOwnerUserId: ME, stepFlag: true })).toBe(REP_LINK);
  });

  it("ISOLATION: a coworker's lead (admin view) → never my link", () => {
    expect(previewMeetingLink({ ...base, leadOwnerUserId: "rep-other", stepFlag: true })).toBeNull();
  });

  it("null/false flag, non-email, or no link → nothing shown", () => {
    expect(previewMeetingLink({ ...base, leadOwnerUserId: ME, stepFlag: null })).toBeNull();
    expect(previewMeetingLink({ ...base, leadOwnerUserId: ME, stepFlag: false })).toBeNull();
    expect(previewMeetingLink({ ...base, channel: "voice", leadOwnerUserId: ME, stepFlag: true })).toBeNull();
    expect(previewMeetingLink({ ...base, myCalendarLink: null, leadOwnerUserId: ME, stepFlag: true })).toBeNull();
  });

  it("appendMeetingCtaLocal mirrors the server: appends, null-safe, idempotent", () => {
    expect(appendMeetingCtaLocal("Body.", null)).toBe("Body.");
    const out = appendMeetingCtaLocal("Body.", REP_LINK)!;
    expect(out).toContain(REP_LINK);
    expect(appendMeetingCtaLocal(out, REP_LINK)).toBe(out); // no double-append
  });
});

// ── persistence ─────────────────────────────────────────────────────────────

describe("draftStepToRow persists the per-step flag", () => {
  const base: DraftStep = {
    step_number: 1, step_type: "intro", channel: "email", delay_days: 0,
    cta_type: "question", custom_instructions: "", active: true,
  };
  it("true/false persist; undefined persists null (inherit)", () => {
    expect(draftStepToRow("c1", { ...base, include_meeting_cta: true }).include_meeting_cta).toBe(true);
    expect(draftStepToRow("c1", { ...base, include_meeting_cta: false }).include_meeting_cta).toBe(false);
    expect(draftStepToRow("c1", base).include_meeting_cta).toBeNull();
  });
});
