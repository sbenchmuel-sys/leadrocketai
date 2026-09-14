// BEHAVIOURAL (Unit G-B P1 — Gmail thread-expansion starvation). Runs in `npm test`.
//
// THE BUG: discovery used `from:<lead> OR to:<lead>`, which admits third-party
// threads (a colleague writing to the lead with the rep copied, list mail,
// tooling that names the lead). The direct-conversation gate correctly rejected
// them — but rejection wrote nothing, so a rejected thread was indistinguishable
// from a never-synced one, sorted to the FRONT of the expansion queue, and won
// one of the 25 slots again on every run. More than 25 of them and a genuine
// older rep↔lead thread was never expanded, while automation kept emailing a
// contact whose reply was sitting in it.
//
// THE FIX: make the gate's predicate the discovery query itself, so third-party
// threads never enter the pool.
//
// WHAT IS MODELLED HERE, stated precisely: Gmail search is not available in a
// unit test, so `matchesGmailQuery` below evaluates ONLY the two query shapes
// this code emits — `from:"a"`, `to:"a"`, AND by adjacency, OR at the top level,
// optional parentheses. `from:` matches the From address; `to:` matches the To
// header only (not Cc), which is Gmail's documented behaviour and the same
// To-only rule the per-message gate applies. It is a narrow, explicit model of
// the operators, not of Gmail's ranking or fuzziness. Everything else in the
// test — the query builder, the thread selector, the cap — is the real code.
import { describe, expect, it } from "vitest";
import {
  gmailDirectDiscoveryQuery,
  selectThreadsToExpand,
} from "../../supabase/functions/_shared/gmailDiscovery.ts";

const LEAD = "manu@acme.com";
const REP = "rep@drivepilot.io";
const MAX_THREADS_PER_LEAD = 25; // the production constant
const MAX_RESULTS = 20; // the production per-message cap

interface Msg {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  cc?: string[];
  daysAgo: number;
}

/** Narrow evaluator of the query grammar this code emits. See header. */
function matchesGmailQuery(msg: Msg, query: string): boolean {
  const disjuncts = query.split(/\s+OR\s+/);
  return disjuncts.some((clause) => {
    const terms = clause.replace(/^\(|\)$/g, "").trim().split(/\s+/);
    return terms.every((term) => {
      const m = /^(from|to):"([^"]+)"$/.exec(term);
      if (!m) throw new Error(`evaluator does not understand term: ${term}`);
      const addr = m[2].toLowerCase();
      return m[1] === "from"
        ? msg.from.toLowerCase() === addr
        : msg.to.map((a) => a.toLowerCase()).includes(addr);
    });
  });
}

/** What gmail-bulk-sync's discovery step produces: thread ids, newest first. */
function discoverThreads(mailbox: Msg[], query: string): string[] {
  const seen = new Set<string>();
  return [...mailbox]
    .sort((a, b) => a.daysAgo - b.daysAgo)
    .filter((m) => matchesGmailQuery(m, query))
    .filter((m) => (seen.has(m.threadId) ? false : (seen.add(m.threadId), true)))
    .map((m) => m.threadId);
}

/** A mailbox with N third-party threads newer than one genuine reply. */
function mailboxWith(thirdPartyThreads: number): Msg[] {
  const noise: Msg[] = Array.from({ length: thirdPartyThreads }, (_, i) => ({
    id: `n-${i}`,
    threadId: `thread-noise-${i}`,
    // A colleague of the lead writing to BOTH the lead and the rep: lead is in
    // To, so `to:<lead>` admits it; the sender is neither party, so the gate
    // rejects it. This is the starvation shape.
    from: "colleague@acme.com",
    to: [LEAD, REP],
    daysAgo: i,
  }));
  const genuineReply: Msg = {
    id: "reply",
    threadId: "thread-reply",
    from: LEAD,
    to: [REP],
    daysAgo: thirdPartyThreads + 5, // older than every noise thread
  };
  return [...noise, genuineReply];
}

describe("THE REGRESSION — 25+ third-party threads must not hide a genuine reply", () => {
  it("with the OLD query the reply's thread is never expanded (documents the bug)", () => {
    const mailbox = mailboxWith(30);
    const oldQuery = `from:"${LEAD}" OR to:"${LEAD}"`;
    const discovered = discoverThreads(mailbox, oldQuery);
    expect(discovered).toHaveLength(31); // every noise thread got in
    const expanded = selectThreadsToExpand(discovered, new Set(), MAX_THREADS_PER_LEAD);
    expect(expanded).not.toContain("thread-reply"); // and the reply lost
    // ...and it is not merely late: rejected threads write nothing, so
    // `previouslySynced` is still empty next run and the same 25 win again.
    const nextRun = selectThreadsToExpand(discovered, new Set(), MAX_THREADS_PER_LEAD);
    expect(nextRun).toEqual(expanded);
  });

  it("with the DIRECT query the reply's thread is expanded on the first run", () => {
    const mailbox = mailboxWith(30);
    const discovered = discoverThreads(mailbox, gmailDirectDiscoveryQuery(LEAD, REP));
    expect(discovered).toEqual(["thread-reply"]); // no noise entered the pool
    const expanded = selectThreadsToExpand(discovered, new Set(), MAX_THREADS_PER_LEAD);
    expect(expanded).toContain("thread-reply");
  });

  it("holds at the per-message cap too — the reply is within the newest 20 eligible", () => {
    const mailbox = mailboxWith(30);
    const eligible = [...mailbox]
      .sort((a, b) => a.daysAgo - b.daysAgo)
      .filter((m) => matchesGmailQuery(m, gmailDirectDiscoveryQuery(LEAD, REP)))
      .slice(0, MAX_RESULTS);
    expect(eligible.map((m) => m.id)).toEqual(["reply"]);
  });

  it("the direct query also drops the lead writing to someone other than the rep", () => {
    const sideConversation: Msg = {
      id: "side", threadId: "thread-side", from: LEAD, to: ["someone@else.com"], daysAgo: 1,
    };
    expect(discoverThreads([sideConversation], gmailDirectDiscoveryQuery(LEAD, REP))).toEqual([]);
  });

  it("keeps both directions of the genuine conversation", () => {
    const inbound: Msg = { id: "in", threadId: "t1", from: LEAD, to: [REP], daysAgo: 1 };
    const outbound: Msg = { id: "out", threadId: "t2", from: REP, to: [LEAD], daysAgo: 2 };
    expect(discoverThreads([inbound, outbound], gmailDirectDiscoveryQuery(LEAD, REP)))
      .toEqual(["t1", "t2"]);
  });
});

describe("gmailDirectDiscoveryQuery", () => {
  it("is the direct-conversation gate as a Gmail query, addresses quoted for exact match", () => {
    expect(gmailDirectDiscoveryQuery(LEAD, REP))
      .toBe(`(from:"${LEAD}" to:"${REP}") OR (from:"${REP}" to:"${LEAD}")`);
  });

  it("normalises case and whitespace", () => {
    expect(gmailDirectDiscoveryQuery(" MANU@Acme.com ", "Rep@DrivePilot.io"))
      .toBe(gmailDirectDiscoveryQuery(LEAD, REP));
  });

  it("falls back to the broad query when the rep address is blank (gate rejects all anyway)", () => {
    expect(gmailDirectDiscoveryQuery(LEAD, "")).toBe(`from:"${LEAD}" OR to:"${LEAD}"`);
  });
});

describe("selectThreadsToExpand", () => {
  it("puts never-synced threads first, keeps caller order within each group", () => {
    const synced = new Set(["k1", "k2"]);
    expect(selectThreadsToExpand(["k1", "n1", "k2", "n2"], synced, 10)).toEqual(["n1", "n2", "k1", "k2"]);
  });

  it("respects the cap", () => {
    expect(selectThreadsToExpand(["a", "b", "c"], new Set(), 2)).toEqual(["a", "b"]);
  });

  it("works through a backlog PROGRESSIVELY — expanded threads leave the front of the queue", () => {
    // 30 never-synced DIRECT threads, cap 25: run 1 takes 25, run 2 takes the
    // remaining 5 because run 1 wrote rows and they are now "previously synced".
    const all = Array.from({ length: 30 }, (_, i) => `d-${i}`);
    const run1 = selectThreadsToExpand(all, new Set(), MAX_THREADS_PER_LEAD);
    expect(run1).toHaveLength(25);
    const afterRun1 = new Set(run1);
    const run2 = selectThreadsToExpand(all, afterRun1, MAX_THREADS_PER_LEAD);
    // The five that missed run 1 are at the front of run 2.
    expect(run2.slice(0, 5)).toEqual(all.slice(25));
  });

  it("does not mutate its input", () => {
    const ids = ["b", "a"];
    selectThreadsToExpand(ids, new Set(["b"]), 5);
    expect(ids).toEqual(["b", "a"]);
  });
});
