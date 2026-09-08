// Unit L2 (Codex P2, twice) — hidden timeline rows must not cost the rep
// anything they can't get back.
//
//  1. Hiding an entry must not remove the "Show hidden" control that restores
//     it. The control's count therefore comes from its own head-only query, not
//     from the rendered list (which is both windowed and filtered).
//  2. The readers apply a fixed 200-row window in SQL, so the fetch asks for
//     exactly what will be rendered. Pulling hidden rows in and filtering them
//     client-side let hidden rows eat the window and push older visible
//     interactions off the page entirely.

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

// The rows the fake backend holds. Newest first.
const store: { rows: TimelineItem[] } = { rows: [makeItem()] };

/** Mirrors the real reader: hidden filter in SQL, THEN the row window. */
const getLeadTimeline = vi.fn(async (_leadId: string, options?: { includeHidden?: boolean; limit?: number }) => {
  const rows = options?.includeHidden ? store.rows : store.rows.filter(r => !r.hidden);
  return rows.slice(0, options?.limit ?? 200);
});

vi.mock("@/lib/supabaseQueries", () => ({
  getLeadTimeline: (...args: unknown[]) => getLeadTimeline(...(args as [string, { includeHidden?: boolean }])),
  getGroupTimelineItems: vi.fn(async () => []),
  hideTimelineItem: vi.fn(async (id: string) => {
    store.rows = store.rows.map(r => (r.id === id ? { ...r, hidden: true } : r));
  }),
  unhideTimelineItem: vi.fn(async (id: string) => {
    store.rows = store.rows.map(r => (r.id === id ? { ...r, hidden: false } : r));
  }),
  insertInteraction: vi.fn(async () => {}),
  setTimelineFollowupState: vi.fn(async () => {}),
}));

// The hidden-row count comes straight from the client — count it off the store.
vi.mock("@/integrations/supabase/client", () => {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    update: () => chain,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (v: { data: unknown[]; count: number; error: null }) => void) =>
      resolve({ data: [], count: store.rows.filter(r => r.hidden).length, error: null }),
  });
  return { supabase: { from: () => chain, auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock("@/hooks/useRealtimeSubscription", () => ({ useRealtimeSubscription: () => {} }));
vi.mock("@/components/dashboard/EmailActionDialog", () => ({ EmailActionDialog: () => null }));
vi.mock("@/components/call/CallTimelineCard", () => ({ default: () => null }));

import TimelineTab from "@/components/lead/TimelineTab";

beforeEach(() => {
  store.rows = [makeItem()];
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
    await waitFor(() => expect(store.rows[0].hidden).toBe(false));
  });

  it("still offers the control when every row on the lead is hidden", async () => {
    store.rows = [makeItem({ hidden: true })];
    render(<TimelineTab leadId="lead-1" addMessageOpen={false} onAddMessageOpenChange={() => {}} />);
    expect(await screen.findByText(/show hidden \(1\)/i)).toBeInTheDocument();
  });
});

describe("timelineRowWindow", () => {
  it("hidden rows never displace older visible ones inside the 200-row window", async () => {
    // 210 interactions, the 5 newest hidden. The visible history is 205 rows,
    // so the newest 200 VISIBLE ones must be what the page shows.
    const now = Date.now();
    store.rows = Array.from({ length: 210 }, (_, i) =>
      makeItem({
        id: `t${i + 1}`,
        source_id: `s${i + 1}`,
        dedupe_key: `d${i + 1}`,
        subject: `Note ${i + 1}`,
        snippet_text: `Body ${i + 1}`,
        occurred_at: new Date(now - i * 60_000).toISOString(),
        hidden: i < 5,
      }),
    );

    render(<TimelineTab leadId="lead-1" addMessageOpen={false} onAddMessageOpenChange={() => {}} />);

    // Newest visible row.
    expect(await screen.findByText("Note 6")).toBeInTheDocument();
    // 200th visible row — the one a window filled with hidden rows would drop.
    expect(screen.getByText("Note 205")).toBeInTheDocument();
    // The fetch asked for exactly what is rendered.
    expect(getLeadTimeline).toHaveBeenCalledWith("lead-1", { includeHidden: false });
    // …and the hidden rows are still accounted for.
    expect(screen.getByText(/show hidden \(5\)/i)).toBeInTheDocument();
  });
});
