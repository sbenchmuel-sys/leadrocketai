import { describe, it, expect } from "vitest";
import { classifyRevenueState, type EnrichedLead } from "./dashboardUtils";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function makeLead(overrides: Partial<EnrichedLead> = {}): EnrichedLead {
  const now = Date.now();
  return {
    id: "lead-1",
    name: "Test Lead",
    email: null,
    phone: null,
    company: null,
    role: null,
    created_at: new Date(now - 10 * DAY).toISOString(),
    last_activity_at: new Date(now).toISOString(),
    stage: "engaged",
    needs_action: false,
    next_action_key: null,
    next_action_label: null,
    hasMeeting: false,
    last_outbound_at: null,
    last_inbound_at: null,
    first_outbound_at: null,
    source_type: "outbound_prospecting",
    motion: "outbound_prospecting",
    displayPhase: "Engaged",
    origin_category: "outbound",
    ...overrides,
  } as EnrichedLead;
}

describe("classifyRevenueState — recent outbound suppression", () => {
  it("does NOT return action_required when user just sent outbound and no later inbound", () => {
    const lead = makeLead({
      needs_action: true,
      last_outbound_at: new Date(Date.now() - 2 * HOUR).toISOString(),
      last_inbound_at: new Date(Date.now() - 5 * DAY).toISOString(),
    });
    expect(classifyRevenueState(lead, new Set(), new Set())).not.toBe("action_required");
  });

  it("DOES return action_required when inbound arrives AFTER recent outbound", () => {
    const lead = makeLead({
      last_outbound_at: new Date(Date.now() - 6 * HOUR).toISOString(),
      last_inbound_at: new Date(Date.now() - 1 * HOUR).toISOString(),
    });
    expect(classifyRevenueState(lead, new Set(), new Set())).toBe("action_required");
  });

  it("DOES return action_required when outbound was >3 days ago and inbound exists", () => {
    const lead = makeLead({
      last_outbound_at: new Date(Date.now() - 10 * DAY).toISOString(),
      last_inbound_at: new Date(Date.now() - 1 * DAY).toISOString(),
    });
    expect(classifyRevenueState(lead, new Set(), new Set())).toBe("action_required");
  });

  it("post_meeting + hasMeeting + recent outbound is NOT action_required (re-engagement scenario)", () => {
    const lead = makeLead({
      stage: "post_meeting",
      hasMeeting: true,
      last_outbound_at: new Date(Date.now() - 4 * HOUR).toISOString(),
      last_inbound_at: new Date(Date.now() - 30 * DAY).toISOString(),
      last_activity_at: new Date(Date.now() - 4 * HOUR).toISOString(),
    });
    expect(classifyRevenueState(lead, new Set(), new Set())).not.toBe("action_required");
  });

  it("post_meeting becomes action_required only when inbound is after outbound", () => {
    const lead = makeLead({
      stage: "post_meeting",
      hasMeeting: true,
      last_outbound_at: new Date(Date.now() - 5 * DAY).toISOString(),
      last_inbound_at: new Date(Date.now() - 1 * DAY).toISOString(),
    });
    expect(classifyRevenueState(lead, new Set(), new Set())).toBe("action_required");
  });

  it("OOO gate suppresses action_required even with inbound", () => {
    const lead = makeLead({
      last_outbound_at: new Date(Date.now() - 10 * DAY).toISOString(),
      last_inbound_at: new Date(Date.now() - 1 * DAY).toISOString(),
    });
    (lead as any).ooo_until = new Date(Date.now() + 3 * DAY).toISOString();
    expect(classifyRevenueState(lead, new Set(), new Set())).not.toBe("action_required");
  });

  it("permanently dismissed suppresses action_required", () => {
    const lead = makeLead({
      needs_action: true,
      last_outbound_at: new Date(Date.now() - 10 * DAY).toISOString(),
    });
    (lead as any).action_permanently_dismissed = true;
    expect(classifyRevenueState(lead, new Set(), new Set())).not.toBe("action_required");
  });

  it("automation takes priority over action_required", () => {
    const lead = makeLead({
      // Consent gate (mirrors the executor): a lead is only "in automation"
      // when automation_mode IS NOT NULL — eligible_at alone is not enough.
      automation_mode: "full_auto",
      needs_action: true,
      eligible_at: new Date(Date.now() + DAY).toISOString(),
      last_outbound_at: new Date(Date.now() - 10 * DAY).toISOString(),
      last_inbound_at: new Date(Date.now() - 1 * DAY).toISOString(),
    });
    expect(classifyRevenueState(lead, new Set(), new Set())).toBe("automation");
  });

  it("future meeting suppresses unreplied-inbound action_required", () => {
    const lead = makeLead({
      last_outbound_at: new Date(Date.now() - 10 * DAY).toISOString(),
      last_inbound_at: new Date(Date.now() - 1 * DAY).toISOString(),
      has_future_meeting: true,
    });
    expect(classifyRevenueState(lead, new Set(), new Set())).not.toBe("action_required");
  });
});

describe("classifyRevenueState — intent hide-list (PR C)", () => {
  it("suppresses action_required when lead is in the intent-hidden set", () => {
    const lead = makeLead({
      needs_action: true,
      last_outbound_at: new Date(Date.now() - 10 * DAY).toISOString(),
      last_inbound_at: new Date(Date.now() - 1 * DAY).toISOString(),
    });
    const hidden = new Set([lead.id]);
    expect(classifyRevenueState(lead, new Set(), new Set(), hidden)).not.toBe("action_required");
  });

  it("does NOT suppress when lead is not in the hidden set", () => {
    const lead = makeLead({
      needs_action: true,
      last_outbound_at: new Date(Date.now() - 10 * DAY).toISOString(),
      last_inbound_at: new Date(Date.now() - 1 * DAY).toISOString(),
    });
    const hidden = new Set<string>(); // empty
    expect(classifyRevenueState(lead, new Set(), new Set(), hidden)).toBe("action_required");
  });

  it("falls back to current behaviour when intentHiddenIds is omitted", () => {
    const lead = makeLead({
      needs_action: true,
      last_outbound_at: new Date(Date.now() - 10 * DAY).toISOString(),
      last_inbound_at: new Date(Date.now() - 1 * DAY).toISOString(),
    });
    expect(classifyRevenueState(lead, new Set(), new Set())).toBe("action_required");
  });

  it("automation still wins over intent-hidden (action_required gate is lower priority)", () => {
    const lead = makeLead({
      needs_action: true,
      eligible_at: new Date(Date.now() + DAY).toISOString(),
      last_outbound_at: new Date(Date.now() - 10 * DAY).toISOString(),
      last_inbound_at: new Date(Date.now() - 1 * DAY).toISOString(),
    });
    (lead as any).automation_mode = "full_auto";
    const hidden = new Set([lead.id]);
    expect(classifyRevenueState(lead, new Set(), new Set(), hidden)).toBe("automation");
  });
});
