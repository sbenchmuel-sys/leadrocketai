import { describe, it, expect } from "vitest";
import type { LeadDetail } from "@/lib/supabaseQueries";
import {
  getAutomationBlockers,
  getAutomationResumeBlocker,
  getAutomationToggleState,
  automationEverEnabled,
  buildAutomationEnableFields,
  AUTOMATION_DISABLE_FIELDS,
  getStepLabels,
} from "@/lib/leadAutomationActions";

// These pure helpers are the single source of truth for what the lead-detail
// Automation control writes to the `leads` table (consent + scheduling). They
// gate the executor's consent check, so a silent drift here could arm or
// fail-to-disarm real automated sends. This suite locks the field shapes that
// were extracted verbatim from AutomationPreviewCard in Unit 3.

function makeLead(overrides: Partial<LeadDetail> & Record<string, unknown>): LeadDetail {
  return {
    id: "lead-1",
    name: "Test Lead",
    email: "test@example.com",
    motion: "outbound_prospecting",
    stage: "new",
    needs_action: false,
    has_future_meeting: false,
    last_inbound_at: null,
    last_outbound_at: null,
    next_action_key: null,
    ...overrides,
  } as unknown as LeadDetail;
}

describe("getAutomationBlockers — mirrors the executor's pause reasons", () => {
  it("returns no blockers for a clean, eligible lead", () => {
    expect(getAutomationBlockers(makeLead({}))).toEqual([]);
  });

  it("flags a lead that has replied (pause-on-reply)", () => {
    const blockers = getAutomationBlockers(makeLead({ last_inbound_at: "2026-06-20T10:00:00Z" }));
    expect(blockers).toContain("Lead has replied");
  });

  it("flags a booked meeting (pause-on-meeting)", () => {
    const blockers = getAutomationBlockers(makeLead({ has_future_meeting: true }));
    expect(blockers).toContain("Meeting scheduled");
  });

  it("flags a closed deal", () => {
    expect(getAutomationBlockers(makeLead({ stage: "closed_won" }))).toContain("Deal closed");
    expect(getAutomationBlockers(makeLead({ stage: "closed_lost" }))).toContain("Deal closed");
  });

  it("flags an unsupported motion", () => {
    expect(getAutomationBlockers(makeLead({ motion: "post_meeting" }))).toContain("Motion changed");
  });
});

describe("AUTOMATION_DISABLE_FIELDS — turning off must revoke consent", () => {
  it("clears the sequence AND automation_mode (the consent gate)", () => {
    expect(AUTOMATION_DISABLE_FIELDS).toEqual({
      needs_action: false,
      next_action_key: null,
      next_action_label: null,
      eligible_at: null,
      action_reason_code: null,
      automation_mode: null,
    });
  });
});

describe("buildAutomationEnableFields — turning on sets explicit consent", () => {
  it("outbound, no prior send → step 1, FOLLOWUP_DUE, full_auto consent", () => {
    const fields = buildAutomationEnableFields(makeLead({}));
    expect(fields.needs_action).toBe(true);
    expect(fields.next_action_key).toBe("send_pre_1");
    expect(fields.next_action_label).toBe("Step 1 of 4");
    expect(fields.action_reason_code).toBe("FOLLOWUP_DUE");
    expect(fields.automation_mode).toBe("full_auto");
    expect(typeof fields.eligible_at).toBe("string");
  });

  it("outbound, prior send → continues from next_action_key", () => {
    const fields = buildAutomationEnableFields(
      makeLead({ last_outbound_at: "2026-06-18T09:00:00Z", next_action_key: "send_pre_3" }),
    );
    expect(fields.next_action_key).toBe("send_pre_3");
    expect(fields.action_reason_code).toBe("FOLLOWUP_DUE");
    expect(fields.automation_mode).toBe("full_auto");
  });

  it("nurture → nurture step, NURTURE_DUE, active status, full_auto consent", () => {
    const fields = buildAutomationEnableFields(makeLead({ motion: "nurture" }));
    expect(fields.next_action_key).toBe("nurture_1");
    expect(fields.next_action_label).toBe("Nurture Email 1");
    expect(fields.action_reason_code).toBe("NURTURE_DUE");
    expect(fields.automation_mode).toBe("full_auto");
    expect(fields.nurture_status).toBe("active");
    expect(fields.nurture_mode).toBe("review");
    expect(typeof fields.eligible_at).toBe("string");
  });

  it("treats a null motion as outbound (no crash, sensible defaults)", () => {
    const fields = buildAutomationEnableFields(makeLead({ motion: null as unknown as string }));
    expect(fields.next_action_key).toBe("send_pre_1");
    expect(fields.automation_mode).toBe("full_auto");
  });
});

describe("getAutomationResumeBlocker — guard resume, allow first-time enable", () => {
  it("allows a first-time enable even when the lead has replied (never enrolled)", () => {
    // e.g. an inbound_response / lookback-seeded lead that carries last_inbound_at
    const lead = makeLead({
      motion: "inbound_response",
      last_inbound_at: "2026-06-20T10:00:00Z",
      // never enrolled: no automation_mode consent
    });
    expect(automationEverEnabled(lead)).toBe(false);
    expect(getAutomationResumeBlocker(lead)).toBeNull();
  });

  it("treats a manual queue item (needs_action/eligible_at but no consent) as never-enrolled", () => {
    const lead = makeLead({
      eligible_at: "2026-06-25T09:30:00Z", needs_action: true, next_action_key: "send_pre_2",
      last_inbound_at: "2026-06-25T11:00:00Z", // even with a 'blocker', no consent → not automation
    } as any);
    expect(automationEverEnabled(lead)).toBe(false);
    expect(getAutomationResumeBlocker(lead)).toBeNull(); // can be enabled, not refused
  });

  it("refuses to resume a previously-enrolled (consented) lead that has replied", () => {
    const lead = makeLead({
      automation_mode: "full_auto",
      last_inbound_at: "2026-06-20T10:00:00Z",
      next_action_key: "send_pre_2",
    } as any);
    expect(automationEverEnabled(lead)).toBe(true);
    expect(getAutomationResumeBlocker(lead)).toBe("Lead has replied");
  });

  it("refuses to resume a previously-enrolled lead with a booked meeting", () => {
    const lead = makeLead({ has_future_meeting: true, automation_mode: "full_auto" } as any);
    expect(getAutomationResumeBlocker(lead)).toBe("Meeting scheduled");
  });

  it("allows resume of a previously-enrolled lead with no blockers", () => {
    const lead = makeLead({ next_action_key: "send_pre_3", automation_mode: "full_auto" } as any);
    expect(getAutomationResumeBlocker(lead)).toBeNull();
  });
});

describe("getAutomationToggleState — the switch must never misreport sending", () => {
  it("clean enrolled+running lead → On", () => {
    const s = getAutomationToggleState(makeLead({
      eligible_at: "2026-06-25T09:30:00Z", needs_action: true, next_action_key: "send_pre_2", automation_mode: "full_auto",
    } as any));
    expect(s.isOn).toBe(true);
    expect(s.safetyPaused).toBe(false);
    expect(s.eligible).toBe(true);
  });

  it("reply lands before executor clears the flags → shows PAUSED, not On (the Codex window)", () => {
    // enrolled + still flagged running, but a reply just arrived
    const s = getAutomationToggleState(makeLead({
      eligible_at: "2026-06-25T09:30:00Z", needs_action: true, next_action_key: "send_pre_2",
      automation_mode: "full_auto", last_inbound_at: "2026-06-25T11:00:00Z",
    } as any));
    expect(s.safetyPaused).toBe(true);
    expect(s.isOn).toBe(false); // must NOT read as "sending"
    expect(s.primaryBlocker).toBe("Lead has replied");
  });

  it("booked meeting before flags clear → shows PAUSED, not On", () => {
    const s = getAutomationToggleState(makeLead({
      eligible_at: "2026-06-25T09:30:00Z", needs_action: true, next_action_key: "send_pre_2",
      automation_mode: "full_auto", has_future_meeting: true,
    } as any));
    expect(s.safetyPaused).toBe(true);
    expect(s.isOn).toBe(false);
  });

  it("never-enrolled lead → Off (not paused), eligible to turn on", () => {
    const s = getAutomationToggleState(makeLead({}));
    expect(s.isOn).toBe(false);
    expect(s.safetyPaused).toBe(false);
    expect(s.userPaused).toBe(false);
  });

  it("manual queue item (needs_action + eligible_at, NO consent) → Off, never 'sending'", () => {
    // upstream sync can flag a manual lead; without automation_mode it must read Off
    const s = getAutomationToggleState(makeLead({
      eligible_at: "2026-06-25T09:30:00Z", needs_action: true, next_action_key: "send_pre_2",
    } as any));
    expect(s.isOn).toBe(false);
    expect(s.safetyPaused).toBe(false);
    expect(s.userPaused).toBe(false);
  });

  it("manually paused (enrolled, no blocker) → userPaused, Off", () => {
    const s = getAutomationToggleState(makeLead({ next_action_key: "send_pre_3", automation_mode: "full_auto" } as any));
    expect(s.isOn).toBe(false);
    expect(s.userPaused).toBe(true);
    expect(s.safetyPaused).toBe(false);
  });

  it("closed deal → not eligible (card hidden)", () => {
    expect(getAutomationToggleState(makeLead({ stage: "closed_won" })).eligible).toBe(false);
  });
});

describe("getStepLabels", () => {
  it("maps each motion to its label set", () => {
    expect(getStepLabels("outbound_prospecting").send_pre_1).toBe("Step 1 of 4");
    expect(getStepLabels("inbound_response").send_pre_1).toBe("Step 1 of 3");
    expect(getStepLabels("nurture").nurture_1).toBe("Nurture Email 1");
  });
});
