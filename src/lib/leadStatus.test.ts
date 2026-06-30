import { describe, it, expect } from "vitest";
import type { EnrichedLead } from "@/lib/dashboardUtils";
import { isInAutomation, isNewLead, leadStatus } from "@/lib/leadStatus";

function lead(partial: Partial<EnrichedLead>): EnrichedLead {
  return {
    id: "l1",
    name: "Test",
    company: "Co",
    email: "t@co.com",
    stage: "contacted",
    ...partial,
  } as unknown as EnrichedLead;
}

// Fixed timestamps — the rule compares inbound vs outbound, not vs now, so
// these tests are clock-independent.
const OLDER = "2026-01-01T00:00:00.000Z";
const NEWER = "2026-02-01T00:00:00.000Z";

describe("isInAutomation", () => {
  it("is true for an enrolled lead with no unanswered reply", () => {
    expect(isInAutomation(lead({ campaign_id: "c1" }))).toBe(true);
    expect(isInAutomation(lead({ automation_mode: "auto" }))).toBe(true);
    expect(isInAutomation(lead({ revenueState: "automation" }))).toBe(true);
  });

  it("is false when a reply has paused automation (inbound newer than outbound)", () => {
    expect(
      isInAutomation(lead({ automation_mode: "auto", last_inbound_at: NEWER, last_outbound_at: OLDER })),
    ).toBe(false);
    // No outbound at all but a reply present → still paused-by-reply.
    expect(
      isInAutomation(lead({ campaign_id: "c1", last_inbound_at: NEWER, last_outbound_at: null })),
    ).toBe(false);
  });

  it("stays in automation once the rep has responded (outbound newer than inbound)", () => {
    expect(
      isInAutomation(lead({ automation_mode: "auto", last_inbound_at: OLDER, last_outbound_at: NEWER })),
    ).toBe(true);
  });

  it("is false when there are no automation signals", () => {
    expect(isInAutomation(lead({}))).toBe(false);
  });
});

describe("isNewLead", () => {
  it("is true for a brand-new lead not in automation", () => {
    expect(isNewLead(lead({ stage: "new" }))).toBe(true);
  });

  it("is false for a new-stage lead already in automation", () => {
    expect(isNewLead(lead({ stage: "new", campaign_id: "c1" }))).toBe(false);
  });

  it("stays out of New for an enrolled new-stage lead even when a reply paused it", () => {
    // Reply-paused → isInAutomation is false, but the lead IS still enrolled, so
    // it must not be counted as New (Codex P2 on PR #106).
    const l = lead({ stage: "new", campaign_id: "c1", last_inbound_at: NEWER, last_outbound_at: OLDER });
    expect(isInAutomation(l)).toBe(false); // display: paused
    expect(isNewLead(l)).toBe(false); // but not "New" — it's enrolled
  });
});

describe("leadStatus", () => {
  it("returns 'in_outreach' for an enrolled lead with no reply", () => {
    expect(leadStatus(lead({ stage: "new", campaign_id: "c1" })).key).toBe("in_outreach");
  });

  it("reply wins: enrolled + unanswered reply → 'hot' (heating_up)", () => {
    const l = lead({
      stage: "new",
      campaign_id: "c1",
      revenueState: "heating_up",
      last_inbound_at: NEWER,
      last_outbound_at: OLDER,
    } as Partial<EnrichedLead>);
    expect(leadStatus(l).key).toBe("hot");
  });

  it("not enrolled + stage new → 'new' (unchanged)", () => {
    expect(leadStatus(lead({ stage: "new" })).key).toBe("new");
  });
});
