// ============================================================
// Unit Q2 — the Outreach tab's counts must never lie in the safe
// direction.
//
// ALL BEHAVIOURAL. The data half drives the real `fetchOutreachQueue`
// against a fake PostgREST client that resolves `{ count: null, error }`
// — the shape supabase-js actually resolves with on a failed read (it
// does NOT reject). The UI half renders the real chip row and asserts on
// what a rep would see.
//
// The bug this pins: `count ?? 0` turned every transient read failure
// into a confident "nothing to do" — the chip showed 0, went disabled,
// and the tab badge undercounted, with a real backlog behind it.
// ============================================================
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// ── Fake PostgREST client ──────────────────────────────────────────
// Every builder method chains and records its name + args; awaiting the
// chain asks `resolve(table, chain)` what that particular query returns.
type Call = { fn: string; args: unknown[] };
let resolve: (table: string, chain: Call[]) => { data: unknown; count?: number | null; error: unknown };

function builder(table: string, chain: Call[]): unknown {
  const target = () => undefined;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") {
        const res = resolve(table, chain);
        return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve(res).then(ok, bad);
      }
      return (...args: unknown[]) => builder(table, [...chain, { fn: String(prop), args }]);
    },
  });
}
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => builder(table, []),
    auth: { getUser: () => Promise.resolve({ data: { user: { id: "me" } } }) },
  },
}));

const { fetchOutreachQueue, reconcileCompleted } = await import("@/lib/outreachQueue");
const { OutreachToday } = await import("@/components/queue/OutreachToday");

/** Is this chain one of the five per-channel HEAD counts, and for which channel? */
function countChannel(chain: Call[]): string | null {
  const select = chain.find((c) => c.fn === "select");
  const head = (select?.args[1] as { head?: boolean } | undefined)?.head === true;
  if (!head) return null;
  const chanEq = chain.find((c) => c.fn === "eq" && c.args[0] === "channel");
  return chanEq ? String(chanEq.args[1]) : null;
}

const OK_CAMPAIGNS = { data: [{ id: "c1", name: "Q3 outbound" }], error: null };

describe("fetchOutreachQueue — a failed count is UNKNOWN, never zero", () => {
  beforeEach(() => {
    resolve = () => ({ data: [], count: 0, error: null });
  });

  it("reports real per-channel counts when every read succeeds", async () => {
    const counts: Record<string, number> = { email: 4, voice: 3, sms: 0, whatsapp: 0, linkedin: 1 };
    resolve = (table, chain) => {
      if (table === "campaigns") return OK_CAMPAIGNS;
      const ch = countChannel(chain);
      if (ch) return { data: null, count: counts[ch], error: null };
      return { data: [], count: 7, error: null };
    };
    const page = await fetchOutreachQueue();
    expect(page.byChannel).toEqual({ email: 4, voice: 3, sms: 0, whatsapp: 0, linkedin: 1 });
    expect(page.total).toBe(7);
    expect(page.countsError).toBeNull();
  });

  it("a failed per-channel count comes back null — NOT 0 — and the others survive", async () => {
    resolve = (table, chain) => {
      if (table === "campaigns") return OK_CAMPAIGNS;
      const ch = countChannel(chain);
      if (ch === "voice") return { data: null, count: null, error: { message: "timeout" } };
      if (ch) return { data: null, count: 2, error: null };
      return { data: [], count: 2, error: null };
    };
    const page = await fetchOutreachQueue();
    expect(page.byChannel.voice).toBeNull();
    expect(page.byChannel.voice).not.toBe(0);
    expect(page.byChannel.email).toBe(2);
  });

  it("reports a PARTIAL count failure so the page can't render it as an all-clear", async () => {
    // The nastiest shape of this bug: the page read succeeds with zero rows, so
    // the function returns normally and the caller's success branch clears its
    // error — leaving "Queue clear. Nice." under a badge reading "—".
    resolve = (table, chain) => {
      if (table === "campaigns") return OK_CAMPAIGNS;
      const ch = countChannel(chain);
      if (ch === "voice") return { data: null, count: null, error: { message: "timeout" } };
      if (ch) return { data: null, count: 0, error: null };
      return { data: [], count: 0, error: null };
    };
    const page = await fetchOutreachQueue();
    expect(page.touches).toEqual([]);
    expect(page.countsError).toMatch(/Call/); // the rep's word for the channel
  });

  it("a failed PAGE read throws instead of returning an empty queue", async () => {
    resolve = (table, chain) => {
      if (table === "campaigns") return OK_CAMPAIGNS;
      if (countChannel(chain)) return { data: null, count: 0, error: null };
      return { data: null, count: null, error: { message: "page read failed" } };
    };
    await expect(fetchOutreachQueue()).rejects.toThrow(/page read failed/);
  });

  it("a failed CAMPAIGNS read throws instead of reporting an empty backlog", async () => {
    // This one is nastier than it looks: an unchecked error left `activeIds`
    // empty, and the function returned a clean, cheerful "nothing due" page.
    resolve = (table) =>
      table === "campaigns"
        ? { data: null, error: { message: "campaigns read failed" } }
        : { data: [], count: 0, error: null };
    await expect(fetchOutreachQueue()).rejects.toThrow(/campaigns read failed/);
  });
});

describe("the chip row never renders an unknown count as nothing-to-do", () => {
  const props = {
    touches: [],
    total: 0,
    loading: false,
    channel: null,
    onSelectChannel: () => {},
    onShowMore: null,
    onDone: () => {},
    onRestore: () => {},
  };

  it("shows '—' and keeps the chip clickable when a count could not be read", () => {
    render(
      <OutreachToday
        {...props}
        byChannel={{ email: 2, voice: null, sms: 0, whatsapp: 0, linkedin: 0 }}
        error="Couldn't read the Call backlog count."
      />,
    );
    const callChip = screen.getByRole("button", { name: /Call/ });
    expect(callChip.textContent).toContain("—");
    expect(callChip.textContent).not.toContain("0");
    expect(callChip).not.toBeDisabled();
    // …and the All total refuses to add up a set it can't see.
    expect(screen.getByRole("button", { name: /All/ }).textContent).toContain("—");
  });

  it("still disables a channel that is genuinely empty", () => {
    render(
      <OutreachToday {...props} byChannel={{ email: 2, voice: 0, sms: 0, whatsapp: 0, linkedin: 0 }} />,
    );
    expect(screen.getByRole("button", { name: /Call/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Email/ })).not.toBeDisabled();
  });

  it("refuses an all-clear over an unknown count even if no error was passed down", () => {
    // The parent's `setOutreachError(page.countsError)` is one line and one line
    // is one place to forget. The tab does not depend on it.
    render(
      <OutreachToday {...props} byChannel={{ email: 0, voice: null, sms: 0, whatsapp: 0, linkedin: 0 }} />,
    );
    expect(screen.getByText(/backlog counts couldn't be read/)).toBeTruthy();
    expect(screen.queryByText(/Queue clear/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Focus mode/ })).not.toBeDisabled();
  });

  it("says the load failed rather than showing the empty state", () => {
    render(
      <OutreachToday
        {...props}
        byChannel={{ email: 0, voice: null, sms: 0, whatsapp: 0, linkedin: 0 }}
        error="Couldn't read the Call backlog count."
      />,
    );
    // Every surface has to agree: banner up, empty state suppressed, focus mode
    // still reachable so the rep can go and look.
    expect(screen.getByText(/Couldn't read the Call backlog count/)).toBeTruthy();
    expect(screen.queryByText(/Queue clear/i)).toBeNull();
    expect(screen.queryByText(/Nothing due/i)).toBeNull();
    expect(screen.getByRole("button", { name: /Focus mode/ })).not.toBeDisabled();
  });
});

describe("reconcileCompleted — an in-flight page load can't re-add a finished card", () => {
  const touch = (id: string) => ({ id });

  it("drops a touch the rep completed while the fetch was in flight", () => {
    const completed = new Map([["t2", 5]]);
    const { touches } = reconcileCompleted([touch("t1"), touch("t2"), touch("t3")], completed, 4);
    expect(touches.map((t) => t.id)).toEqual(["t1", "t3"]);
  });

  it("keeps suppressing it until a request that STARTED after the completion lands", () => {
    const completed = new Map([["t2", 5]]);
    // A response from a request started BEFORE the completion still lists t2 —
    // that is exactly the stale response we are defending against.
    const stale = reconcileCompleted([touch("t2")], completed, 4);
    expect(stale.touches).toEqual([]);
    expect(stale.completed.has("t2")).toBe(true);
    // The first response that COULD know about the completion retires the
    // memory, whether or not the touch is in it.
    const fresh = reconcileCompleted([touch("t1")], stale.completed, 6);
    expect(fresh.completed.has("t2")).toBe(false);
  });

  it("lets a re-queued touch come back instead of hiding it for the session", () => {
    // Snooze re-queues the touch with a later eligible_at. The prune used to be
    // conditional on the id being ABSENT from the response, which is never true
    // for a re-queued touch — so it stayed invisible through every reload.
    let completed = new Map([["t2", 5]]);
    const first = reconcileCompleted([touch("t2")], completed, 10);
    expect(first.touches).toEqual([]); // still suppressed in THIS response
    completed = first.completed;
    const second = reconcileCompleted([touch("t2")], completed, 11);
    expect(second.touches.map((t) => t.id)).toEqual(["t2"]); // and back on the next
  });
});
