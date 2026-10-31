// The Pilot page asks pilot_report() for the whole pilot plus one call per week
// so far (newest first), and shows nothing at all to a workspace with no pilot.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

let settingsRow: unknown = null;
const rpcCalls: Record<string, unknown>[] = [];
const report = (n: number) => ({
  emails_sent: n, replies: 0, positive_replies: 0, bounces: 0, linkedin_done: 0, linkedin_accepted: 0,
  calls_dialled: 0, conversations: 0, calls_answered: 0, meetings_booked: 0, waiting_on_rep: 0,
  leads_by_stage: {}, call_recaps: [], reply_summaries: [{ lead: "Ann", company: "Acme", intent: "book_meeting", summary: "Wants a demo" }],
});
const chain: any = { select: () => chain, eq: () => chain, maybeSingle: () => Promise.resolve({ data: settingsRow }) };
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => chain,
    rpc: (_fn: string, args: Record<string, unknown>) => { rpcCalls.push(args); return Promise.resolve({ data: report(rpcCalls.length), error: null }); },
  },
}));
vi.mock("@/contexts/WorkspaceContext", () => ({ useWorkspace: () => ({ workspaceId: "ws1" }) }));
const { default: Pilot } = await import("@/pages/Pilot");

describe("Pilot page", () => {
  beforeEach(() => { rpcCalls.length = 0; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-20T12:00:00Z")); });

  it("loads the pilot total plus one report per week so far, newest week first", async () => {
    settingsRow = { client_name: "Paythings", pilot_start: "2026-11-04", pilot_weeks: 12, meetings_target: 12 };
    render(<Pilot />);
    await waitFor(() => expect(screen.getByText("Paythings pilot")).toBeTruthy());
    expect(rpcCalls).toHaveLength(1 + 3); // total + weeks 1..3
    expect(rpcCalls[0]._from).toBe(new Date("2026-11-04").toISOString());
    const rows = screen.getAllByText(/^Week \d$/).map((e) => e.textContent?.split(" (")[0]);
    expect(rows).toEqual(["Week 3", "Week 2", "Week 1"]);
    expect(screen.getByText(/Wants a demo/)).toBeTruthy();
  });

  it("says there's no pilot instead of showing zeros", async () => {
    settingsRow = null;
    render(<Pilot />);
    await waitFor(() => expect(screen.getByText(/no pilot set up/)).toBeTruthy());
    expect(rpcCalls).toHaveLength(0);
  });
});
