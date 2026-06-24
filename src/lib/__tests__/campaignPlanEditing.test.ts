// ============================================================================
// Cadence touch editor — pure plan mutations + the persisted row shape.
// Locks the behaviour a rep relies on when shaping a draft outreach: add a
// call/text/email anywhere, reorder, switch a channel, keep the schedule
// intact, flag (never drop) a text that needs SMS setup, and persist the
// per-step "Include a meeting link" choice.
// ============================================================================

import { describe, it, expect } from "vitest";

import {
  buildDefaultPlan,
  cumulativeDays,
  normalizePlan,
  insertStep,
  removeStep,
  moveStep,
  changeStepChannel,
  setStepGap,
  setStepMeetingCta,
  stepNeedsSmsSetup,
  emailIntent,
  type DraftStep,
} from "@/lib/campaignDefaults";
import { draftStepToRow } from "@/lib/campaignQueries";
import type { CanonicalChannel } from "@/lib/channels";

// A tiny, readable plan builder for tests: a list of channels → a draft plan
// with explicit gaps, already normalized.
function plan(
  defs: Array<{ ch: CanonicalChannel; gap: number }>,
): DraftStep[] {
  return normalizePlan(
    defs.map((d, i) => ({
      step_number: i + 1,
      step_type: "followup",
      channel: d.ch,
      delay_days: d.gap,
      cta_type: "question",
      custom_instructions: "",
      active: true,
      include_meeting_cta: null,
    })),
  );
}

const channels = (p: DraftStep[]) => p.map((s) => s.channel);
const gaps = (p: DraftStep[]) => p.map((s) => s.delay_days);

// ── Normalization invariants ────────────────────────────────────────────────

describe("normalizePlan — keeps the plan coherent", () => {
  it("renumbers 1..N and forces the first touch to day 0", () => {
    const p = plan([
      { ch: "email", gap: 5 }, // a stale non-zero first gap
      { ch: "voice", gap: 2 },
    ]);
    expect(p.map((s) => s.step_number)).toEqual([1, 2]);
    expect(p[0].delay_days).toBe(0);
  });

  it("makes the first email intro, the last email breakup, the rest follow-ups", () => {
    const p = plan([
      { ch: "email", gap: 0 },
      { ch: "email", gap: 2 },
      { ch: "email", gap: 2 },
    ]);
    expect(p.map((s) => s.step_type)).toEqual(["intro", "followup", "breakup"]);
    expect(p[2].cta_type).toBe("breakup_close");
  });

  it("leaves non-email touches' types alone", () => {
    const p = plan([
      { ch: "email", gap: 0 },
      { ch: "voice", gap: 2 },
      { ch: "sms", gap: 2 },
    ]);
    expect(p[1].step_type).toBe("followup");
    expect(p[2].step_type).toBe("followup");
  });
});

// ── 1. Insert a call between two emails ──────────────────────────────────────

describe("insertStep — add a call between two emails", () => {
  it("produces email · call · email in order, renumbered", () => {
    const p = plan([
      { ch: "email", gap: 0 },
      { ch: "email", gap: 3 },
    ]);
    const next = insertStep(p, 1, "voice"); // insert as the new step 2
    expect(channels(next)).toEqual(["email", "voice", "email"]);
    expect(next.map((s) => s.step_number)).toEqual([1, 2, 3]);
    // The inserted call is a manual touch, not email — never auto-sent.
    expect(next[1].channel).toBe("voice");
  });

  it("appends at the end when atIndex is past the list", () => {
    const p = plan([{ ch: "email", gap: 0 }]);
    const next = insertStep(p, 99, "sms");
    expect(channels(next)).toEqual(["email", "sms"]);
  });

  it("re-derives email roles when a call splits the emails", () => {
    // Two emails: intro + breakup. Insert a call between → the second email is
    // still the last email, so it stays the breakup.
    const p = plan([
      { ch: "email", gap: 0 },
      { ch: "email", gap: 3 },
    ]);
    const next = insertStep(p, 1, "voice");
    expect(next[0].step_type).toBe("intro");
    expect(next[2].step_type).toBe("breakup");
  });
});

// ── 2. Reorder persists and keeps the schedule ───────────────────────────────

describe("moveStep — reorder keeps the overall schedule", () => {
  it("moves a touch up and the change persists in order", () => {
    const p = plan([
      { ch: "email", gap: 0 },
      { ch: "email", gap: 2 },
      { ch: "voice", gap: 3 },
    ]);
    const next = moveStep(p, 2, -1); // move the call up one slot
    expect(channels(next)).toEqual(["email", "voice", "email"]);
  });

  it("does not shift the landing days — only the message types swap slots", () => {
    const p = plan([
      { ch: "email", gap: 0 }, // day 0
      { ch: "email", gap: 2 }, // day 2
      { ch: "voice", gap: 3 }, // day 5
    ]);
    const before = cumulativeDays(p);
    const next = moveStep(p, 2, -1);
    expect(cumulativeDays(next)).toEqual(before); // [0, 2, 5] unchanged
  });

  it("is a no-op past the ends", () => {
    const p = plan([
      { ch: "email", gap: 0 },
      { ch: "voice", gap: 2 },
    ]);
    expect(moveStep(p, 0, -1)).toEqual(p);
    expect(moveStep(p, 1, 1)).toEqual(p);
  });
});

// ── 3. Change an existing touch's channel ────────────────────────────────────

describe("changeStepChannel — switch what a touch is", () => {
  it("turns a text into an email and stores the new channel", () => {
    const p = plan([
      { ch: "email", gap: 0 },
      { ch: "sms", gap: 2 },
    ]);
    const next = changeStepChannel(p, 1, "email");
    expect(next[1].channel).toBe("email");
  });

  it("clears the meeting-link flag when a touch leaves email", () => {
    let p = plan([
      { ch: "email", gap: 0 },
      { ch: "email", gap: 2 },
    ]);
    p = setStepMeetingCta(p, 1, true);
    expect(p[1].include_meeting_cta).toBe(true);
    const next = changeStepChannel(p, 1, "voice");
    expect(next[1].channel).toBe("voice");
    expect(next[1].include_meeting_cta).toBeNull();
  });
});

// ── 4. SMS step with sms_enabled off is FLAGGED, not dropped ──────────────────

describe("stepNeedsSmsSetup — a text without SMS is flagged, never removed", () => {
  it("flags a text touch when the workspace can't send texts", () => {
    const p = plan([
      { ch: "email", gap: 0 },
      { ch: "sms", gap: 2 },
    ]);
    expect(stepNeedsSmsSetup(p[1], false)).toBe(true);
    // The step is still in the plan — flagging does not drop it.
    expect(channels(p)).toEqual(["email", "sms"]);
  });

  it("does not flag the text once SMS is enabled, and never flags non-texts", () => {
    const p = plan([
      { ch: "email", gap: 0 },
      { ch: "sms", gap: 2 },
    ]);
    expect(stepNeedsSmsSetup(p[1], true)).toBe(false);
    expect(stepNeedsSmsSetup(p[0], false)).toBe(false);
  });
});

// ── 5. "Include a meeting link" persists through the write path ───────────────

describe("setStepMeetingCta + draftStepToRow — meeting link persists", () => {
  it("ticks the flag only on the chosen email step", () => {
    const p = plan([
      { ch: "email", gap: 0 },
      { ch: "email", gap: 2 },
      { ch: "email", gap: 2 },
    ]);
    // Tick emails 2 and 3 only (indexes 1 and 2), leave 1 untouched.
    const next = setStepMeetingCta(setStepMeetingCta(p, 1, true), 2, true);
    expect(next.map((s) => s.include_meeting_cta)).toEqual([null, true, true]);
  });

  it("ignores a meeting tick on a non-email touch", () => {
    const p = plan([
      { ch: "email", gap: 0 },
      { ch: "voice", gap: 2 },
    ]);
    const next = setStepMeetingCta(p, 1, true);
    expect(next[1].include_meeting_cta ?? null).toBeNull();
  });

  it("writes campaign_steps.include_meeting_cta in the persisted row", () => {
    const p = setStepMeetingCta(
      plan([
        { ch: "email", gap: 0 },
        { ch: "email", gap: 2 },
      ]),
      1,
      true,
    );
    const row = draftStepToRow("camp-1", { ...p[1], custom_instructions: "" });
    expect(row.include_meeting_cta).toBe(true);
    expect(row.channel).toBe("email");
  });

  it("defaults the persisted flag to null (inherit) when never set", () => {
    const row = draftStepToRow("camp-1", {
      step_number: 1,
      step_type: "intro",
      channel: "email",
      delay_days: 0,
      cta_type: "question",
      custom_instructions: "",
      active: true,
    });
    expect(row.include_meeting_cta).toBeNull();
  });
});

// ── Delete keeps later touches on the same days ──────────────────────────────

describe("removeStep — deleting a touch preserves the rest of the schedule", () => {
  it("rolls the removed gap into the next touch so later days don't shift", () => {
    const p = plan([
      { ch: "email", gap: 0 }, // day 0
      { ch: "voice", gap: 2 }, // day 2
      { ch: "email", gap: 3 }, // day 5
    ]);
    const next = removeStep(p, 1); // remove the middle call
    expect(channels(next)).toEqual(["email", "email"]);
    // The surviving final email must still land on day 5, not slide up to day 3.
    expect(cumulativeDays(next)).toEqual([0, 5]);
  });

  it("keeps at least one touch", () => {
    const p = plan([{ ch: "email", gap: 0 }]);
    expect(removeStep(p, 0)).toEqual(p);
  });

  it("forces day 0 after the first touch is removed", () => {
    const p = plan([
      { ch: "email", gap: 0 },
      { ch: "email", gap: 4 },
    ]);
    const next = removeStep(p, 0);
    expect(next).toHaveLength(1);
    expect(gaps(next)).toEqual([0]);
  });
});

// ── Default plan still flows through the editor cleanly ───────────────────────

describe("editor over the default 9-touch plan", () => {
  it("normalizes without changing the channel mix", () => {
    const def = buildDefaultPlan(["voice", "sms"]);
    const norm = normalizePlan(def);
    expect(channels(norm)).toEqual(channels(def));
    expect(norm[0].delay_days).toBe(0);
  });

  it("emailIntent reads in plain language", () => {
    expect(emailIntent("intro")).toBe("first message");
    expect(emailIntent("breakup")).toBe("last message");
    expect(emailIntent("followup")).toBe("follow-up");
  });
});
