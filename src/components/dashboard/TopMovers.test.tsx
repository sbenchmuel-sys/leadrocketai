import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TopMovers } from "./TopMovers";
import type { EnrichedLead } from "@/lib/dashboardUtils";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function makeLead(overrides: Partial<EnrichedLead> = {}): EnrichedLead {
  return {
    id: "l1",
    name: "Acme Lead",
    email: null,
    phone: null,
    company: null,
    role: null,
    created_at: new Date(Date.now() - 30 * DAY).toISOString(),
    last_activity_at: new Date().toISOString(),
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

function renderMovers(leads: EnrichedLead[]) {
  return render(
    <MemoryRouter>
      <TopMovers leads={leads} />
    </MemoryRouter>
  );
}

describe("TopMovers — eligibility & scoring", () => {
  it("does NOT include a lead whose only recent activity is the user's outbound send", () => {
    const lead = makeLead({
      name: "Outbound Only",
      last_outbound_at: new Date(Date.now() - 1 * HOUR).toISOString(),
      last_activity_at: new Date(Date.now() - 1 * HOUR).toISOString(),
      last_inbound_at: new Date(Date.now() - 30 * DAY).toISOString(),
    });
    renderMovers([lead]);
    expect(screen.queryByText("Outbound Only")).not.toBeInTheDocument();
    expect(screen.getByText(/No significant movement/i)).toBeInTheDocument();
  });

  it("includes a lead with a real inbound in the last 48h", () => {
    const lead = makeLead({
      name: "Replied Lead",
      last_outbound_at: new Date(Date.now() - 5 * DAY).toISOString(),
      last_inbound_at: new Date(Date.now() - 2 * HOUR).toISOString(),
    });
    renderMovers([lead]);
    expect(screen.getByText("Replied Lead")).toBeInTheDocument();
  });

  it("labels long-gap inbound as 'Reactivated after N days'", () => {
    const lead = makeLead({
      name: "Reactivated",
      last_outbound_at: new Date(Date.now() - 30 * DAY).toISOString(),
      last_inbound_at: new Date(Date.now() - 1 * HOUR).toISOString(),
    });
    renderMovers([lead]);
    expect(screen.getByText(/Reactivated after \d+ days/)).toBeInTheDocument();
  });

  it("does NOT include action_required-only leads (no mirror of Action Required panel)", () => {
    const lead = makeLead({
      name: "Action Only",
      revenueState: "action_required",
      last_activity_at: new Date(Date.now() - 1 * HOUR).toISOString(),
      // no recent inbound, no meeting
    });
    renderMovers([lead]);
    expect(screen.queryByText("Action Only")).not.toBeInTheDocument();
  });

  it("includes meeting scheduled in last 48h", () => {
    const lead = makeLead({
      name: "Meeting Lead",
      stage: "post_meeting",
      hasMeeting: true,
      last_activity_at: new Date(Date.now() - 3 * HOUR).toISOString(),
    });
    renderMovers([lead]);
    expect(screen.getByText("Meeting Lead")).toBeInTheDocument();
    expect(screen.getByText(/Meeting scheduled/)).toBeInTheDocument();
  });

  it("ignores inbound that predates the last outbound (already responded to)", () => {
    const lead = makeLead({
      name: "Old Inbound",
      last_inbound_at: new Date(Date.now() - 5 * HOUR).toISOString(),
      last_outbound_at: new Date(Date.now() - 1 * HOUR).toISOString(),
    });
    renderMovers([lead]);
    expect(screen.queryByText("Old Inbound")).not.toBeInTheDocument();
  });
});
