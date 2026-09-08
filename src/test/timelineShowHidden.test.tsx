// Unit L2 (Codex P2) — hiding a timeline entry must never strip away the
// control that brings it back.
//
// The Show-hidden toggle used to live inside the Filter popover, which the
// one-column page hides on short histories, so it was pulled out into its own
// chip. That chip was gated on `hiddenCount`, which was computed from a fetch
// that EXCLUDED hidden rows — so the moment a rep hid something the count fell
// to zero and the chip vanished with it. The timeline now always fetches hidden
// rows and only filters them at render time.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TimelineItem } from "@/lib/supabaseQueries";

function makeItem(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    id: "t1",
    lead_id: "lead-1",
    channel: "system",
    provider: null,
    direction: null,
    event_type: "system_note",
    occurred_at: new Date().toISOString(),
    source_table: "lead_timeline_items",
    source_id: "s1",
    snippet_text: "Called their office, left a voicemail",
    subject: "Voicemail note",
    status_json: {},
    metadata_json: {},
    dedupe_key: "d1",
    contact_id: null,
    conversation_id: null,
    hidden: false,
    ...overrides,
  };
}

// One in-memory row whose `hidden` flag the mocked hide/unhide calls flip.
const store = { item: makeItem() };
const getLeadTimeline = vi.fn(async (_leadId: string, options?: { includeHidden?: boolean }) =>
  options?.includeHidden || !store.item.hidden ? [store.item] : [],
);

vi.mock("@/lib/supabaseQueries", () => ({
  getLeadTimeline: (...args: unknown[]) => getLeadTimeline(...(args as [string, { includeHidden?: boolean }])),
  getGroupTimelineItems: vi.fn(async () => []),
  hideTimelineItem: vi.fn(async () => { store.item = { ...store.item, hidden: true }; }),
  unhideTimelineItem: vi.fn(async () => { store.item = { ...store.item, hidden: false }; }),
  insertInteraction: vi.fn(async () => {}),
  setTimelineFollowupState: vi.fn(async () => {}),
}));
vi.mock("@/integrations/supabase/client", () => {
  const chain: {
    select: () => unknown; eq: () => unknown; update: () => unknown;
    maybeSingle: () => Promise<unknown>; then: (r: (v: { data: unknown[] }) => void) => void;
  } = {
    select: () => chain, eq: () => chain, update: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve) => resolve({ data: [] }),
  };
  return { supabase: { from: () => chain, auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/hooks/useRealtimeSubscription", () => ({ useRealtimeSubscription: () => {} }));
vi.mock("@/components/dashboard/EmailActionDialog", () => ({ EmailActionDialog: () => null }));
vi.mock("@/components/call/CallTimelineCard", () => ({ default: () => null }));

import TimelineTab from "@/components/lead/TimelineTab";

beforeEach(() => {
  store.item = makeItem();
  getLeadTimeline.mockClear();
});

describe("timelineShowHidden", () => {
  it("keeps the Show-hidden control after hiding, and toggling restores the row", async () => {
    render(<TimelineTab leadId="lead-1" addMessageOpen={false} onAddMessageOpenChange={() => {}} />);

    expect(await screen.findByText("Voicemail note")).toBeInTheDocument();
    // Nothing hidden yet — no control needed.
    expect(screen.queryByText(/show hidden/i)).toBeNull();

    fireEvent.click(screen.getByTitle("Hide"));

    // The row goes away, but the way back does NOT.
    await waitFor(() => expect(screen.queryByText("Voicemail note")).toBeNull());
    const showHidden = await screen.findByText(/show hidden \(1\)/i);

    fireEvent.click(showHidden);
    expect(await screen.findByText("Voicemail note")).toBeInTheDocument();
    expect(screen.getByText(/hide hidden items/i)).toBeInTheDocument();

    // And it can be un-hidden from there.
    fireEvent.click(screen.getByTitle("Unhide"));
    await waitFor(() => expect(store.item.hidden).toBe(false));
  });

  it("always fetches hidden rows so the count can never be filtered away", async () => {
    render(<TimelineTab leadId="lead-1" />);
    await screen.findByText("Voicemail note");
    expect(getLeadTimeline).toHaveBeenCalledWith("lead-1", { includeHidden: true });
  });
});
