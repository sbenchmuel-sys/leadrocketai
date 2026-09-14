// Run: deno test supabase/functions/_shared/leadResolution.test.ts
//
// BEHAVIOURAL. Deno mirror of src/test/leadResolution.test.ts.
//
// THE BUG: the Outlook webhook resolved several lead rows for one address with
// `.order("created_at").limit(1)` — the OLDEST row. The row carrying the live
// campaign is usually the NEWER one, so a customer's reply, and the
// instant-pause that rides with it, both landed on a dormant duplicate while the
// active row carried on emailing someone who had just written back.
//
// The headline test is "the reply does not land on the dormant duplicate"; it
// fails if the tiebreak goes back to oldest-first.
//
// Measured on production 2026-09-14: 6 duplicate groups inside a single
// workspace, 14 rows — 4 groups with NO armed row, 1 with exactly one, 1 with
// SEVERAL. The no-match / one / many / many-armed cases below are all real.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";

/** Minimal describe/it shim over Deno.test so this mirrors the vitest file. */
let currentSuite = "";
function describe(name: string, body: () => void) { currentSuite = name; body(); currentSuite = ""; }
function it(name: string, fn: () => void) { Deno.test(`${currentSuite} > ${name}`, fn); }
const expect = (actual: any) => ({
  toBe: (e: unknown) => assertEquals(actual, e),
  toEqual: (e: unknown) => assertEquals(actual, e),
  toBeNull: () => assertEquals(actual, null),
  toHaveLength: (n: number) => assertEquals(actual.length, n),
});
import {
  type LeadLikeRow,
  orderLeadsByLiveness,
  pickPrimaryLead,
} from "./leadResolution.ts";

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();

function lead(over: Partial<LeadLikeRow> & { id: string }): LeadLikeRow {
  return {
    unsubscribed: false,
    automation_mode: null,
    nurture_status: "inactive",
    last_activity_at: null,
    created_at: ago(100),
    ...over,
  };
}

describe("pickPrimaryLead: the reply goes to the live row", () => {
  it("THE REGRESSION — an armed newer duplicate wins over a dormant older one", () => {
    // Exactly Codex's case. Oldest-first returns "dormant" and the reply is
    // filed against a row nobody is working, while "active" keeps sending.
    const dormant = lead({ id: "dormant", created_at: ago(400) });
    const active = lead({ id: "active", created_at: ago(10), automation_mode: "auto" });

    expect(pickPrimaryLead([dormant, active])?.id).toBe("active");
    // Order is independent of the order rows come back from Postgres.
    expect(pickPrimaryLead([active, dormant])?.id).toBe("active");
  });

  it("an unsubscribed row never wins, even if it is armed and newest", () => {
    const stopped = lead({ id: "stopped", created_at: ago(1), automation_mode: "auto", unsubscribed: true });
    const live = lead({ id: "live", created_at: ago(300) });
    expect(pickPrimaryLead([stopped, live])?.id).toBe("live");
  });

  it("active nurture beats inactive when neither is armed", () => {
    const inactive = lead({ id: "inactive", created_at: ago(1) });
    const nurturing = lead({ id: "nurturing", created_at: ago(200), nurture_status: "active" });
    expect(pickPrimaryLead([inactive, nurturing])?.id).toBe("nurturing");
  });

  it("with no stronger signal, recent activity decides", () => {
    const stale = lead({ id: "stale", last_activity_at: ago(90), created_at: ago(1) });
    const busy = lead({ id: "busy", last_activity_at: ago(2), created_at: ago(300) });
    expect(pickPrimaryLead([stale, busy])?.id).toBe("busy");
  });

  it("with no signal at all, the NEWER row wins — the reversal of the old rule", () => {
    const older = lead({ id: "older", created_at: ago(400) });
    const newer = lead({ id: "newer", created_at: ago(5) });
    expect(pickPrimaryLead([older, newer])?.id).toBe("newer");
  });

  it("a row that has never been active does not beat one that has", () => {
    const never = lead({ id: "never", created_at: ago(1), last_activity_at: null });
    const once = lead({ id: "once", created_at: ago(50), last_activity_at: ago(30) });
    expect(pickPrimaryLead([never, once])?.id).toBe("once");
  });
});

describe("pickPrimaryLead: no match and many match", () => {
  it("NO match returns null — there is no fallback and no guessing", () => {
    expect(pickPrimaryLead([])).toBeNull();
  });

  it("ONE match returns it unchanged", () => {
    const only = lead({ id: "only" });
    expect(pickPrimaryLead([only])?.id).toBe("only");
  });

  it("MANY identical rows resolve deterministically, never arbitrarily", () => {
    const a = lead({ id: "aaa", created_at: ago(7) });
    const b = lead({ id: "bbb", created_at: ago(7) });
    const c = lead({ id: "ccc", created_at: ago(7) });
    // Same answer whatever order Postgres hands them back in.
    expect(pickPrimaryLead([a, b, c])?.id).toBe("aaa");
    expect(pickPrimaryLead([c, b, a])?.id).toBe("aaa");
    expect(pickPrimaryLead([b, c, a])?.id).toBe("aaa");
  });

  it("SEVERAL armed rows still resolve — and every one is still returned", () => {
    // Production has a group like this. Attribution picks one; the caller pauses
    // all of them, which is what stops the un-picked sender.
    const armedOld = lead({ id: "armed-old", created_at: ago(200), automation_mode: "auto" });
    const armedNew = lead({ id: "armed-new", created_at: ago(3), automation_mode: "auto" });
    const dormant = lead({ id: "dormant", created_at: ago(1) });

    expect(pickPrimaryLead([armedOld, armedNew, dormant])?.id).toBe("armed-new");
    expect(orderLeadsByLiveness([armedOld, armedNew, dormant]).map((r) => r.id))
      .toEqual(["armed-new", "armed-old", "dormant"]);
  });
});

describe("orderLeadsByLiveness: every row survives, so the guardrails can reach them", () => {
  it("returns every input row — the guardrails are applied to all of them", () => {
    const rows = [lead({ id: "a" }), lead({ id: "b" }), lead({ id: "c" })];
    expect(orderLeadsByLiveness(rows).map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the caller's array", () => {
    const rows = [lead({ id: "z", created_at: ago(400) }), lead({ id: "a", created_at: ago(1) })];
    const before = rows.map((r) => r.id);
    orderLeadsByLiveness(rows);
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it("tolerates an unparseable timestamp instead of ordering on NaN", () => {
    const broken = lead({ id: "broken", created_at: "not-a-date", last_activity_at: "also-not" });
    const good = lead({ id: "good", created_at: ago(500) });
    expect(orderLeadsByLiveness([broken, good]).map((r) => r.id)).toEqual(["good", "broken"]);
  });
});
