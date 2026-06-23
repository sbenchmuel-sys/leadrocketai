import { describe, it, expect } from "vitest";
import type { LeadDetail } from "@/lib/supabaseQueries";
import { getLeadStatusLine } from "@/lib/leadStatusLine";

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

function lead(partial: Partial<LeadDetail>): LeadDetail {
  return {
    id: "l1",
    name: "Test",
    company: "Co",
    email: "t@co.com",
    stage: "contacted",
    ...partial,
  } as unknown as LeadDetail;
}

describe("getLeadStatusLine", () => {
  it("reports closed deals plainly", () => {
    expect(getLeadStatusLine(lead({ stage: "closed_won" }))).toBe("Closed — won");
    expect(getLeadStatusLine(lead({ stage: "closed_lost" }))).toBe("Closed — lost");
  });

  it("surfaces an active out-of-office", () => {
    const until = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(getLeadStatusLine(lead({ ooo_until: until } as Partial<LeadDetail>))).toMatch(/^Out of office until /);
  });

  it("leads with a booked meeting", () => {
    expect(getLeadStatusLine(lead({ has_future_meeting: true }))).toBe("Meeting booked");
  });

  it("flags a recent reply as warm", () => {
    expect(
      getLeadStatusLine(lead({ last_inbound_at: daysAgo(2), last_outbound_at: daysAgo(5) })),
    ).toBe("Replied 2 days ago · warm");
  });

  it("notes an older reply without the warm tag", () => {
    expect(
      getLeadStatusLine(lead({ last_inbound_at: daysAgo(10), last_outbound_at: daysAgo(20) })),
    ).toBe("Replied a week ago");
  });

  it("shows waiting when we emailed recently with no reply", () => {
    expect(
      getLeadStatusLine(lead({ last_outbound_at: daysAgo(2) })),
    ).toBe("Waiting on a reply · emailed 2 days ago");
  });

  it("shows gone quiet when our last email has aged out", () => {
    expect(
      getLeadStatusLine(lead({ last_outbound_at: daysAgo(4) })),
    ).toBe("Gone quiet · last emailed 4 days ago");
  });

  it("flags a fresh inbound we have never answered", () => {
    expect(getLeadStatusLine(lead({ last_inbound_at: daysAgo(1) }))).toBe("New — not contacted yet");
  });

  it("falls back to no-outreach when nothing has happened", () => {
    expect(getLeadStatusLine(lead({}))).toBe("No outreach yet");
  });

  it("never leaks system words into the visible text", () => {
    const lines = [
      getLeadStatusLine(lead({ stage: "closed_won" })),
      getLeadStatusLine(lead({ has_future_meeting: true })),
      getLeadStatusLine(lead({ last_inbound_at: daysAgo(2), last_outbound_at: daysAgo(5) })),
      getLeadStatusLine(lead({ last_outbound_at: daysAgo(9) })),
      getLeadStatusLine(lead({})),
    ];
    for (const line of lines) {
      expect(line).not.toMatch(/\b(stage|motion|outbound|inbound)\b/i);
    }
  });
});
