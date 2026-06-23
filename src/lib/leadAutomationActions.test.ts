import { describe, it, expect } from "vitest";
import type { LeadDetail } from "@/lib/supabaseQueries";
import {
  getAutomationBlockers,
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

describe("getStepLabels", () => {
  it("maps each motion to its label set", () => {
    expect(getStepLabels("outbound_prospecting").send_pre_1).toBe("Step 1 of 4");
    expect(getStepLabels("inbound_response").send_pre_1).toBe("Step 1 of 3");
    expect(getStepLabels("nurture").nurture_1).toBe("Nurture Email 1");
  });
});
