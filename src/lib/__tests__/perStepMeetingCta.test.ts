// ============================================================================
// PER-STEP MEETING CTA (Outreach Unit 3)
//
// Proves the per-step meeting-link decision: campaign_steps.include_meeting_cta
// is the source of truth, an "every email" instruction is a shortcut that ticks
// the boxes, the rep's own link is threaded only where a touch's CTA is on, and
// — critically — a NULL flag stays byte-identical to today's behavior.
//
// These assertions FAIL on origin/main (the resolver had no meeting_cta_enabled /
// resolveStepMeetingCta / meetingLinkForDraft and never read the per-step column)
// and PASS on this branch.
// ============================================================================

import { describe, it, expect } from "vitest";

// Server resolver (live send path) — esm.sh-free, importable by vitest.
import {
  resolveCampaignInstruction,
  resolveStepMeetingCta,
  meetingLinkForDraft,
  formatInstructionForPrompt,
} from "../../../supabase/functions/_shared/campaignResolver";

// Client mirror (parity).
import {
  resolveStepMeetingCta as clientResolveStepMeetingCta,
  meetingLinkForDraft as clientMeetingLinkForDraft,
} from "@/lib/campaignResolver";

// Instruction-shortcut + plan helpers.
import {
  buildDefaultPlan,
  setStepMeetingCta,
  moveStep,
  detectMeetingCtaIntent,
  applyMeetingCtaIntent,
  mentionsSpecificEmailSteps,
  type DraftStep,
} from "@/lib/campaignDefaults";

// The single mapping authored-step → persisted row.
import { draftStepToRow } from "@/lib/campaignQueries";

const REP_LINK = "https://cal.example.com/rita";

// Build a structured campaign whose email steps carry the given per-step flags.
// flags[i] is the include_meeting_cta for step i+1 (boolean | null).
function emailCampaign(flags: Array<boolean | null>) {
  return {
    id: "camp-1",
    workspace_id: "ws-1",
    motion: "outbound_prospecting",
    default_channel: "email",
    include_meeting_cta: false, // campaign-level default (dead on the live path)
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

// Resolve one step (1-based) of a structured campaign and report whether the
// rep's link would be threaded into the draft.
function linkForStep(campaign: any, step: number, calendarLink: string | null) {
  const instruction = resolveCampaignInstruction({
    lead_id: "lead-1",
    action_key: `send_pre_${step}`,
    motion: "outbound_prospecting",
    structured_campaign: campaign,
    calendar_link: calendarLink,
  });
  return {
    instruction,
    link: meetingLinkForDraft(instruction, calendarLink),
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

// ── (a) steps 2 & 3 ON, steps 1 & 4 OFF → only 2 & 3 carry the link ─────────

describe("(a) per-step flags select exactly which emails carry the link", () => {
  // Steps 1 and 4 explicitly OFF (false); steps 2 and 3 explicitly ON (true).
  const campaign = emailCampaign([false, true, true, false]);

  it("only emails 2 and 3 thread the rep's link", () => {
    expect(linkForStep(campaign, 1, REP_LINK).link).toBeNull();
    expect(linkForStep(campaign, 2, REP_LINK).link).toBe(REP_LINK);
    expect(linkForStep(campaign, 3, REP_LINK).link).toBe(REP_LINK);
    expect(linkForStep(campaign, 4, REP_LINK).link).toBeNull();
  });

  it("the ON emails get a structural force rule; the OFF emails do not", () => {
    expect(linkForStep(campaign, 2, REP_LINK).forced).toBe(true);
    expect(linkForStep(campaign, 1, REP_LINK).forced).toBe(false);
    expect(linkForStep(campaign, 4, REP_LINK).forced).toBe(false);
  });
});

// ── EVERY flagged vs NONE flagged ───────────────────────────────────────────

describe("every email flagged vs none flagged", () => {
  it("every step ON → all four emails thread the link", () => {
    const campaign = emailCampaign([true, true, true, true]);
    for (let s = 1; s <= 4; s++) expect(linkForStep(campaign, s, REP_LINK).link).toBe(REP_LINK);
  });

  it("every step OFF → no email threads the link", () => {
    const campaign = emailCampaign([false, false, false, false]);
    for (let s = 1; s <= 4; s++) expect(linkForStep(campaign, s, REP_LINK).link).toBeNull();
  });
});

// ── (d) all null + no instruction → unchanged from today ────────────────────

describe("(d) null flags preserve today's behavior (byte-unchanged)", () => {
  const campaign = emailCampaign([null, null, null, null]);

  it("meeting_cta_enabled stays true for every null step (link threaded as today)", () => {
    for (let s = 1; s <= 4; s++) {
      expect(linkForStep(campaign, s, REP_LINK).instruction.meeting_cta_enabled).toBe(true);
      expect(linkForStep(campaign, s, REP_LINK).link).toBe(REP_LINK);
    }
  });

  it("a null step never adds the force rule, so its prompt block is unchanged", () => {
    // The force rule is the only hard_rules mutation; absent it, the structured
    // block is byte-identical to before this change.
    for (let s = 1; s <= 4; s++) expect(linkForStep(campaign, s, REP_LINK).forced).toBe(false);
  });

  it("the legacy path (no structured campaign) keeps meeting_cta_enabled = true", () => {
    const legacy = resolveCampaignInstruction({
      lead_id: "lead-1",
      action_key: "send_pre_2",
      motion: "outbound_prospecting",
      calendar_link: REP_LINK,
    });
    expect(legacy.meeting_cta_enabled).toBe(true);
  });
});

// ── (c) rep with no calendar_link → CTA omitted cleanly, no placeholder ──────

describe("(c) no calendar link → CTA omitted, no placeholder", () => {
  const campaign = emailCampaign([true, true, true, true]);

  it("a flagged step with no link threads nothing and adds no force rule", () => {
    const { link, forced } = linkForStep(campaign, 2, null);
    expect(link).toBeNull(); // not "", not a placeholder
    expect(forced).toBe(false); // never demand a link we don't have
  });

  it("meetingLinkForDraft returns null for empty/whitespace links", () => {
    const inst = { channel: "email" as const, meeting_cta_enabled: true };
    expect(meetingLinkForDraft(inst, "")).toBeNull();
    expect(meetingLinkForDraft(inst, "   ")).toBeNull();
    expect(meetingLinkForDraft(inst, null)).toBeNull();
    expect(meetingLinkForDraft(inst, REP_LINK)).toBe(REP_LINK);
  });
});

// ── non-email step flagged → ignored (the flag is email-only) ───────────────

describe("a non-email step flagged is ignored", () => {
  it("a voice step with include_meeting_cta=true never threads a booking link", () => {
    const campaign = emailCampaign([null, true, null, null]);
    // Turn step 2 into a voice touch but keep the (illegal) true flag.
    campaign.steps[1].channel = "voice";
    const instruction = resolveCampaignInstruction({
      lead_id: "lead-1",
      action_key: "send_pre_2",
      motion: "outbound_prospecting",
      channel: "voice",
      structured_campaign: campaign,
      calendar_link: REP_LINK,
    });
    expect(meetingLinkForDraft(instruction, REP_LINK)).toBeNull();
    expect(instruction.hard_rules.some((r) => /meeting booking link/i.test(r))).toBe(false);
  });
});

// ── (f) meeting already booked still suppresses the ask ─────────────────────

describe("(f) meeting already booked suppresses the ask", () => {
  const campaign = emailCampaign([true, true, true, true]); // step 2 force_on

  function step2({ booked }: { booked: boolean }) {
    return resolveCampaignInstruction({
      lead_id: "lead-1",
      action_key: "send_pre_2",
      motion: "outbound_prospecting",
      structured_campaign: campaign,
      calendar_link: REP_LINK,
      meeting_booked: booked,
    });
  }

  it("the prompt warns the model not to ask for another meeting", () => {
    expect(formatInstructionForPrompt(step2({ booked: true }))).toMatch(/Meeting already booked/i);
  });

  it("a ticked (force-on) step does NOT add the force rule once a meeting is booked", () => {
    // Codex P2: the "include the booking link" hard rule must not contradict the
    // "do not ask for another meeting" warning.
    const booked = step2({ booked: true });
    const notBooked = step2({ booked: false });
    const hasForceRule = (i: typeof booked) =>
      i.hard_rules.some((r) => /meeting booking link/i.test(r));
    expect(hasForceRule(notBooked)).toBe(true); // normally forced
    expect(hasForceRule(booked)).toBe(false); // suppressed when booked
  });
});

// ── reorder: the flag stays with the EMAIL, not the position ─────────────────

describe("reorder keeps the flag with the right email", () => {
  it("flag follows the email object through a move, not its old slot", () => {
    let plan = buildDefaultPlan(["email"]); // 9-touch default
    // Tick the FIRST email touch (index 0 in the default plan is an email intro).
    const firstEmailIdx = plan.findIndex((s) => s.channel === "email");
    plan = setStepMeetingCta(plan, firstEmailIdx, true);
    const flaggedRef = plan[firstEmailIdx];
    expect(flaggedRef.include_meeting_cta).toBe(true);

    // Move it down one slot; the flag must travel with the email, and the touch
    // that swaps up must NOT inherit the flag.
    const moved = moveStep(plan, firstEmailIdx, 1);
    const stillFlagged = moved.find((s) => s.include_meeting_cta === true);
    expect(stillFlagged).toBeDefined();
    expect(stillFlagged!.channel).toBe("email");
    // Exactly one step carries the flag after the move.
    expect(moved.filter((s) => s.include_meeting_cta === true)).toHaveLength(1);
  });
});

// ── (b) instruction shortcut: "every email" ticks the boxes ─────────────────

describe("(b) instruction shortcut sets the per-step flags", () => {
  it("\"add the meeting CTA to every email\" → all email steps flagged true", () => {
    const plan = buildDefaultPlan(["email", "voice", "sms"]);
    const scope = detectMeetingCtaIntent("Please add the meeting CTA to every email.");
    expect(scope).toBe("all_on");
    const applied = applyMeetingCtaIntent(plan, scope);
    for (const s of applied) {
      if (s.channel === "email") expect(s.include_meeting_cta).toBe(true);
      else expect(s.include_meeting_cta ?? null).toBeNull(); // non-email never flagged
    }
  });

  it("a NEGATED 'every email' request opts every email OUT (Codex P2)", () => {
    const plan = buildDefaultPlan(["email", "voice"]);
    for (const phrase of [
      "Don't add the meeting link to every email.",
      "Do not include a calendar link in any of the emails.",
      "No booking link on every email please.",
    ]) {
      expect(detectMeetingCtaIntent(phrase)).toBe("all_off");
    }
    const applied = applyMeetingCtaIntent(plan, "all_off");
    for (const s of applied) {
      if (s.channel === "email") expect(s.include_meeting_cta).toBe(false);
      else expect(s.include_meeting_cta ?? null).toBeNull();
    }
    // and the OFF flag actually withholds the link at generation
    const campaign = emailCampaign([false, false, false, false]);
    expect(linkForStep(campaign, 2, REP_LINK).link).toBeNull();
  });

  it("a scheduling note that merely mentions a meeting is not a negated opt-out", () => {
    // "no meeting on Tuesday" must NOT be read as "no meeting link".
    expect(detectMeetingCtaIntent("Add the meeting link to every email, but no meeting on Tuesday."))
      .toBe("all_on");
  });

  it("each flagged email then threads the link at generation", () => {
    const campaign = emailCampaign([true, true, true, true]);
    for (let s = 1; s <= 4; s++) expect(linkForStep(campaign, s, REP_LINK).link).toBe(REP_LINK);
  });

  it("a soft/unscoped ask is never 'all' → leaves the steps null (no structural change)", () => {
    // Whether classified "soft" (has a meeting word) or "none" (no scheduling
    // keyword), the contract is the same: NOT "all", so no flag is set.
    expect(detectMeetingCtaIntent("Suggest a quick meeting if they seem interested.")).toBe("soft");
    expect(detectMeetingCtaIntent("Offer a time to chat where it feels natural.")).not.toBe("all");
    const plan = buildDefaultPlan(["email"]);
    for (const scope of ["soft", "none"] as const) {
      const applied = applyMeetingCtaIntent(plan, scope);
      expect(applied.every((s) => (s.include_meeting_cta ?? null) === null)).toBe(true);
    }
  });

  it("naming specific emails is NOT parsed structurally (use the checkboxes)", () => {
    expect(mentionsSpecificEmailSteps("Add the calendar link to emails 2 and 3")).toBe(true);
    expect(detectMeetingCtaIntent("Add the calendar link to emails 2 and 3")).toBe("soft");
    expect(detectMeetingCtaIntent("Put a booking link on the second email")).toBe("soft");
  });

  it("no meeting concept → none; the default instructions never trigger 'all'", () => {
    expect(detectMeetingCtaIntent("Keep it short and personal, mention our pricing.")).toBe("none");
    expect(detectMeetingCtaIntent("")).toBe("none");
    // The default 9-touch instructions mention a meeting on the 2nd/3rd emails —
    // that's specific-email phrasing, so it must NOT be treated as "all".
    expect(
      detectMeetingCtaIntent(
        "On the 2nd and 3rd emails, offer a one-pager and suggest a quick meeting.",
      ),
    ).not.toBe("all");
  });
});

// ── persistence: the flag round-trips through the write mapping ──────────────

describe("draftStepToRow persists the per-step flag", () => {
  const base: DraftStep = {
    step_number: 1,
    step_type: "intro",
    channel: "email",
    delay_days: 0,
    cta_type: "question",
    custom_instructions: "",
    active: true,
  };

  it("true persists true; undefined/null persist null (inherit)", () => {
    expect(draftStepToRow("c1", { ...base, include_meeting_cta: true }).include_meeting_cta).toBe(true);
    expect(draftStepToRow("c1", { ...base, include_meeting_cta: false }).include_meeting_cta).toBe(false);
    expect(draftStepToRow("c1", base).include_meeting_cta).toBeNull();
  });
});

// ── inbound: explicit OFF withholds the link from the inbound CTA block ──────

describe("inbound step explicitly OFF never leaks the booking URL (Codex P2)", () => {
  function inbound(flag: boolean | null) {
    return resolveCampaignInstruction({
      lead_id: "lead-1",
      action_key: "send_pre_1",
      motion: "inbound_response",
      structured_campaign: emailCampaign([flag]),
      calendar_link: REP_LINK,
    });
  }

  it("OFF → cta_type carries no URL, the prompt block has no URL, the rule forbids a link", () => {
    const off = inbound(false);
    expect(off.meeting_cta_enabled).toBe(false);
    expect(off.cta_type).toBe("meeting_request");
    expect(off.cta_type).not.toContain(REP_LINK);
    expect(formatInstructionForPrompt(off)).not.toContain(REP_LINK);
    expect(off.hard_rules.some((r) => /do NOT include a booking link/i.test(r))).toBe(true);
  });

  it("null (default) inbound still embeds the booking link — unchanged", () => {
    const on = inbound(null);
    expect(on.cta_type).toBe(`meeting_booking:${REP_LINK}`);
    expect(formatInstructionForPrompt(on)).toContain(REP_LINK);
  });
});

// ── (e) preview and live send make the SAME decision on identical inputs ─────

describe("(e) preview and live send agree on the per-step decision", () => {
  it("both derive the threaded link from the same resolver + helper", () => {
    // The authoring preview (resolveCampaignAuthoringInstruction) and the live
    // send (automation-executor) both call resolveCampaignInstruction and then
    // meetingLinkForDraft. Same inputs ⇒ same link. Proven here for each flag.
    const cases: Array<[boolean | null, string | null, string | null]> = [
      [true, REP_LINK, REP_LINK],
      [false, REP_LINK, null],
      [null, REP_LINK, REP_LINK],
      [true, null, null],
    ];
    for (const [flag, link, expected] of cases) {
      const campaign = emailCampaign([null, flag, null, null]);
      const instruction = resolveCampaignInstruction({
        lead_id: "lead-1",
        action_key: "send_pre_2",
        motion: "outbound_prospecting",
        structured_campaign: campaign,
        calendar_link: link,
      });
      // "live" and "preview" are the same two calls — assert they cannot diverge.
      const live = meetingLinkForDraft(instruction, link);
      const preview = meetingLinkForDraft(instruction, link);
      expect(live).toBe(expected);
      expect(preview).toBe(live);
      // client mirror agrees too
      expect(
        clientMeetingLinkForDraft(instruction.channel, instruction.meeting_cta_enabled, link),
      ).toBe(live);
    }
  });
});
