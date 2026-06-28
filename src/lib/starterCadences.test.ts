import { describe, expect, it } from "vitest";
import {
  STARTER_CADENCES,
  cadenceUsesSms,
  getStarterCadence,
  starterToCreateInput,
  starterToDraftSteps,
} from "./starterCadences";
import { cumulativeDays } from "./campaignDefaults";

const WORKSPACE = "ws-00000000-0000-0000-0000-000000000001";

describe("starter cadence library", () => {
  it("exposes exactly the three documented starters", () => {
    expect(STARTER_CADENCES.map((c) => c.id)).toEqual([
      "inbound_intro",
      "cold_outbound",
      "reengage",
    ]);
  });

  it("numbers steps 1..N with no gaps and keeps every touch active", () => {
    for (const cadence of STARTER_CADENCES) {
      const steps = starterToDraftSteps(cadence);
      expect(steps.map((s) => s.step_number)).toEqual(
        steps.map((_, i) => i + 1),
      );
      expect(steps.every((s) => s.active)).toBe(true);
      // First touch always goes out immediately.
      expect(steps[0].delay_days).toBe(0);
    }
  });

  it("converts absolute day-offsets back into the authored schedule", () => {
    // delay_days is a per-touch GAP; cumulativeDays must reproduce the
    // absolute day each touch was authored to land on.
    for (const cadence of STARTER_CADENCES) {
      const steps = starterToDraftSteps(cadence);
      expect(cumulativeDays(steps)).toEqual(cadence.touches.map((t) => t.day));
    }
  });

  it("Inbound Intro: right count, channels, order and offsets (multi-channel)", () => {
    const steps = starterToDraftSteps(getStarterCadence("inbound_intro")!);
    expect(steps).toHaveLength(7);
    expect(steps.map((s) => s.channel)).toEqual([
      "email",
      "voice",
      "email",
      "sms",
      "email",
      "voice",
      "email",
    ]);
    expect(steps.map((s) => s.step_type)).toEqual([
      "intro",
      "followup",
      "followup",
      "followup",
      "followup",
      "followup",
      "breakup",
    ]);
    expect(cumulativeDays(steps)).toEqual([0, 1, 2, 3, 5, 6, 9]);
  });

  it("Cold Outbound: four email-only touches over twelve days", () => {
    const steps = starterToDraftSteps(getStarterCadence("cold_outbound")!);
    expect(steps).toHaveLength(4);
    expect(steps.every((s) => s.channel === "email")).toBe(true);
    expect(steps.map((s) => s.step_type)).toEqual([
      "intro",
      "followup",
      "followup",
      "breakup",
    ]);
    expect(cumulativeDays(steps)).toEqual([0, 3, 7, 12]);
  });

  it("Re-engage: reuses re_engagement step semantics, email-only", () => {
    const cadence = getStarterCadence("reengage")!;
    const steps = starterToDraftSteps(cadence);
    expect(steps).toHaveLength(3);
    expect(steps.every((s) => s.channel === "email")).toBe(true);
    expect(steps.map((s) => s.step_type)).toEqual([
      "re_engagement",
      "followup",
      "breakup",
    ]);
    expect(cadence.touches[0].templateKey).toBe("re_engagement_intro");
    expect(cumulativeDays(steps)).toEqual([0, 4, 9]);
  });

  it("only Inbound Intro carries an SMS touch", () => {
    expect(cadenceUsesSms(getStarterCadence("inbound_intro")!)).toBe(true);
    expect(cadenceUsesSms(getStarterCadence("cold_outbound")!)).toBe(false);
    expect(cadenceUsesSms(getStarterCadence("reengage")!)).toBe(false);
  });

  it("clones into a workspace-scoped DRAFT in review mode (send_mode unset)", () => {
    const cadence = getStarterCadence("inbound_intro")!;
    const input = starterToCreateInput(cadence, WORKSPACE);

    // Workspace isolation: the clone belongs only to the creating workspace.
    expect(input.workspace_id).toBe(WORKSPACE);
    expect(input.name).toBe("Inbound Intro");
    expect(input.steps).toHaveLength(cadence.touches.length);

    // send_mode is never set here — createCampaignWithSteps omits it too, so the
    // row falls to the DB default 'review' (manual). Guard against a regression
    // that would smuggle an auto-send flag through the clone input.
    expect("send_mode" in input).toBe(false);
    expect(JSON.stringify(input)).not.toContain("automatic");
  });

  it("each starter clones in as its intended motion", () => {
    expect(getStarterCadence("inbound_intro")!.motion).toBe("inbound_response");
    expect(getStarterCadence("cold_outbound")!.motion).toBe("outbound_prospecting");
    expect(getStarterCadence("reengage")!.motion).toBe("re_engagement");
  });

  it("starterToCreateInput threads the motion through to the create input", () => {
    expect(starterToCreateInput(getStarterCadence("inbound_intro")!, WORKSPACE).motion).toBe(
      "inbound_response",
    );
    expect(starterToCreateInput(getStarterCadence("cold_outbound")!, WORKSPACE).motion).toBe(
      "outbound_prospecting",
    );
  });

  it("hides only Re-engage from the picker (still present in the library for tests/future use)", () => {
    // The picker renders STARTER_CADENCES.filter((c) => !c.hidden).
    const visible = STARTER_CADENCES.filter((c) => !c.hidden).map((c) => c.id);
    expect(visible).toEqual(["inbound_intro", "cold_outbound"]);
    expect(getStarterCadence("reengage")!.hidden).toBe(true);
    expect(getStarterCadence("inbound_intro")!.hidden).toBeFalsy();
    expect(getStarterCadence("cold_outbound")!.hidden).toBeFalsy();
  });
});
