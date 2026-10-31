// The Queue is each person's own work. RLS lets a workspace admin SEE every
// teammate's leads, so without an explicit owner filter a client admin (e.g. a
// CRO watching a pilot rep) got the rep's approve / call cards in his own Queue.
import { describe, expect, it, vi } from "vitest";

type Call = { fn: string; args: unknown[] };
const queries: { table: string; chain: Call[] }[] = [];

function builder(table: string, chain: Call[]): unknown {
  const target = () => undefined;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") {
        queries.push({ table, chain });
        const data = table === "campaigns" ? [{ id: "c1", name: "Pilot" }] : [];
        return (ok: (v: unknown) => unknown) => Promise.resolve({ data, count: 0, error: null }).then(ok);
      }
      return (...args: unknown[]) => builder(table, [...chain, { fn: String(prop), args }]);
    },
  });
}
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => builder(table, []),
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: "me" } } }),
      getSession: () => Promise.resolve({ data: { session: { user: { id: "me" } } } }),
    },
  },
}));
const { fetchOutreachQueue } = await import("@/lib/outreachQueue");
const { fetchQueueLeads } = await import("@/lib/queueQueries");

const hasEq = (chain: Call[], col: string, val: string) =>
  chain.some((c) => c.fn === "eq" && c.args[0] === col && c.args[1] === val);

describe("Queue shows only the signed-in user's own leads", () => {
  it("outreach cards and their per-channel counts are filtered to my leads", async () => {
    queries.length = 0;
    await fetchOutreachQueue();
    const touchQueries = queries.filter((q) => q.table === "campaign_touch");
    expect(touchQueries.length).toBeGreaterThan(1); // page + channel counts
    for (const q of touchQueries) expect(hasEq(q.chain, "leads.owner_user_id", "me")).toBe(true);
  });

  it("reply / follow-up leads are filtered to my leads", async () => {
    queries.length = 0;
    await fetchQueueLeads();
    const leadQuery = queries.find((q) => q.table === "leads");
    expect(leadQuery && hasEq(leadQuery.chain, "owner_user_id", "me")).toBe(true);
  });
});
