// ============================================================================
// LinkedIn cadence channel — locks the authoring + generation side of making
// "linkedin" a first-class cadence channel (the Queue runtime already existed).
// Covers: canonical channel mapping, the three LinkedIn touches in the default
// plan (with email fallback), and the step_type → ai_task generation mapping.
// ============================================================================

import { describe, it, expect } from "vitest";
import { Linkedin } from "lucide-react";

import {
  canonicalLabel,
  canonicalIcon,
  channelColors,
  providerToCanonical,
  type CanonicalChannel,
} from "@/lib/channels";
import { buildDefaultPlan, touchVerb } from "@/lib/campaignDefaults";
import { primaryTaskForChannel } from "@/lib/generateCampaignContent";
import type { CampaignStep } from "@/lib/campaignQueries";

function step(channel: CanonicalChannel, step_type: string): CampaignStep {
  return { channel, step_type } as unknown as CampaignStep;
}

// ── Channel mapping ─────────────────────────────────────────────────────────

describe("channels — linkedin is a first-class canonical channel", () => {
  it("labels linkedin as 'LinkedIn'", () => {
    expect(canonicalLabel("linkedin")).toBe("LinkedIn");
  });

  it("uses the lucide Linkedin icon", () => {
    expect(canonicalIcon("linkedin")).toBe(Linkedin);
  });

  it("maps the 'linkedin' provider to the 'linkedin' canonical channel", () => {
    expect(providerToCanonical("linkedin")).toBe("linkedin");
    expect(providerToCanonical("LinkedIn")).toBe("linkedin"); // case-insensitive
  });

  it("has its own colour tokens (not the email fallback)", () => {
    const c = channelColors("linkedin");
    expect(c).toBeTruthy();
    expect(c).not.toEqual(channelColors("email"));
  });
});

// ── Default plan: the three LinkedIn touches ────────────────────────────────

describe("buildDefaultPlan — three LinkedIn touches when linkedin is selected", () => {
  it("verb for linkedin reads 'LinkedIn'", () => {
    expect(touchVerb("linkedin")).toBe("LinkedIn");
  });

  it("includes exactly three linkedin touches: connect (intro), react (value_add), follow-up (followup)", () => {
    const plan = buildDefaultPlan(["linkedin"]);
    const li = plan.filter((s) => s.channel === "linkedin");
    expect(li).toHaveLength(3);
    // Ordered earliest→latest: connection request, reaction, follow-up message.
    expect(li.map((s) => s.step_type)).toEqual(["intro", "value_add", "followup"]);
    // Every touch keeps a positive delay so the plan still reads naturally.
    for (const t of li) expect(t.delay_days).toBeGreaterThan(0);
  });

  it("falls back to email (full plan, zero linkedin touches) when linkedin is NOT selected", () => {
    const withLi = buildDefaultPlan(["linkedin"]);
    const without = buildDefaultPlan([]);
    // Same number of touches either way — fallback never drops a touch.
    expect(without).toHaveLength(withLi.length);
    expect(without.some((s) => s.channel === "linkedin")).toBe(false);
    // The would-be linkedin touches are now email, step_types preserved.
    expect(without.filter((s) => s.channel === "email").length).toBeGreaterThan(
      withLi.filter((s) => s.channel === "email").length,
    );
  });
});

// ── Generation mapping: step_type → LinkedIn ai_task ────────────────────────

describe("primaryTaskForChannel — LinkedIn touch types route to the right ai_task", () => {
  it("intro → linkedin_connect (connection request)", () => {
    expect(primaryTaskForChannel(step("linkedin", "intro"))).toBe("linkedin_connect");
  });

  it("value_add → linkedin_reaction (react to their post)", () => {
    expect(primaryTaskForChannel(step("linkedin", "value_add"))).toBe("linkedin_reaction");
  });

  it("followup → linkedin_followup (follow-up message)", () => {
    expect(primaryTaskForChannel(step("linkedin", "followup"))).toBe("linkedin_followup");
    expect(primaryTaskForChannel(step("linkedin", "breakup"))).toBe("linkedin_followup");
  });

  it("non-linkedin channels are unchanged", () => {
    expect(primaryTaskForChannel(step("email", "intro"))).toBe("pre_email_1_intro");
    expect(primaryTaskForChannel(step("voice", "followup"))).toBe("cold_call_talking_points");
    expect(primaryTaskForChannel(step("sms", "followup"))).toBe("sms_message");
  });
});
