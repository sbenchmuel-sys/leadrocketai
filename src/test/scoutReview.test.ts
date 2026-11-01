// Lead Scout batch review helpers (pure): toast copy, "Week of" header, batch grouping.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: null }) }));

import { groupScoutBatches, scoutToastText, weekOfLabel } from "@/components/leads/scout/ScoutReview";

describe("scoutToastText", () => {
  it("matches the UX copy", () => {
    expect(scoutToastText({ added: 23, skipped_no_email: 2, skipped_other: 0, retry: 0 }))
      .toBe("23 added · 2 skipped (no verified email)");
    expect(scoutToastText({ added: 5, skipped_no_email: 0, skipped_other: 0, retry: 0 })).toBe("5 added");
    expect(scoutToastText({ added: 0, skipped_no_email: 0, skipped_other: 1, retry: 2 }))
      .toBe("0 added · 1 skipped (already known or blocked) · 2 not done, try again");
  });
});

describe("weekOfLabel", () => {
  it("uses the batch's workspace-local Monday", () => {
    expect(weekOfLabel("2026-11-09", "2026-11-10T12:00:00Z")).toBe("Week of Nov 9");
  });
  it("falls back to the row date for a failed/unknown key", () => {
    expect(weekOfLabel("2026-11-09:failed:x", "2026-11-03T12:00:00Z")).toBe("Week of Nov 3");
    expect(weekOfLabel(null, "2026-11-03T12:00:00Z")).toBe("Week of Nov 3");
  });
});

describe("groupScoutBatches", () => {
  it("groups by batch, newest batch first, order kept inside a batch", () => {
    const rows = [
      { id: "a1", scout_batch_id: "A", created_at: "2026-11-02T12:00:00Z" },
      { id: "b1", scout_batch_id: "B", created_at: "2026-11-09T12:00:00Z" },
      { id: "a2", scout_batch_id: "A", created_at: "2026-11-02T12:00:00Z" },
    ];
    const g = groupScoutBatches(rows);
    expect(g.map(([k, items]) => [k, items.map((r) => r.id)])).toEqual([["B", ["b1"]], ["A", ["a1", "a2"]]]);
  });
});
