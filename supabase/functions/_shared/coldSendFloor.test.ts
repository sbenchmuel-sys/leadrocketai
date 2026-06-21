// Run: deno test supabase/functions/_shared/coldSendFloor.test.ts
//
// Exercises the REAL fail-closed floor (coldSendFloor + sendColdEmailTouch) against
// a mock supabase client — no refactor of the orchestration, no live DB, no network.
// The floor is the last line before a cold email reaches a real person, so every
// blocked condition must FAIL CLOSED (return ok:false / refuse to send), and the
// happy path must pass. The pure sub-rules (email-validity, suppression matching)
// are additionally unit-tested in src/lib/__tests__/coldSendFloorRules.test.ts.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { coldSendFloor, sendColdEmailTouch } from "./coldOutreach.ts";

type Resp = { data: unknown; error: unknown };

/** Minimal supabase-client stand-in: canned {data,error} per table, records the
 *  tables touched so a test can prove a path short-circuited before sending. */
function mockClient(byTable: Record<string, Resp>) {
  const calls: string[] = [];
  const builderFor = (table: string) => {
    const res = byTable[table] ?? { data: null, error: null };
    // deno-lint-ignore no-explicit-any
    const b: any = {};
    b.select = () => b;
    b.eq = () => b;
    b.in = () => b;
    b.limit = () => b;
    b.insert = () => b;
    b.update = () => b;
    b.maybeSingle = () => Promise.resolve(res);
    b.single = () => Promise.resolve(res);
    // deno-lint-ignore no-explicit-any
    b.then = (f: any, r: any) => Promise.resolve(res).then(f, r);
    return b;
  };
  return {
    from: (t: string) => {
      calls.push(t);
      return builderFor(t);
    },
    calls,
  };
}

const LEAD = "lead-1";
const WS = "ws-1";
const noSuppression: Resp = { data: [], error: null };

// ── coldSendFloor: each blocked condition fails closed ──────────────────────
Deno.test("floor blocks an unsubscribed lead", async () => {
  // deno-lint-ignore no-explicit-any
  const c = mockClient({ leads: { data: { email: "lead@acme.com", unsubscribed: true }, error: null } }) as any;
  assertEquals(await coldSendFloor(c, LEAD, WS), { ok: false, reason: "lead unsubscribed" });
});

Deno.test("floor fails closed when the lead lookup errors", async () => {
  // deno-lint-ignore no-explicit-any
  const c = mockClient({ leads: { data: null, error: { message: "boom" } } }) as any;
  assertEquals(await coldSendFloor(c, LEAD, WS), { ok: false, reason: "lead lookup failed" });
});

Deno.test("floor fails closed when the lead is missing", async () => {
  // deno-lint-ignore no-explicit-any
  const c = mockClient({ leads: { data: null, error: null } }) as any;
  assertEquals(await coldSendFloor(c, LEAD, WS), { ok: false, reason: "lead lookup failed" });
});

Deno.test("floor blocks an invalid lead email", async () => {
  // deno-lint-ignore no-explicit-any
  const c = mockClient({ leads: { data: { email: "not-an-email", unsubscribed: false }, error: null } }) as any;
  assertEquals(await coldSendFloor(c, LEAD, WS), { ok: false, reason: "invalid email" });
});

Deno.test("floor blocks a lead suppressed by exact EMAIL", async () => {
  const c = mockClient({
    leads: { data: { email: "lead@acme.com", unsubscribed: false }, error: null },
    campaign_suppression_list: { data: [{ kind: "email", value: "lead@acme.com" }], error: null },
    // deno-lint-ignore no-explicit-any
  }) as any;
  assertEquals(await coldSendFloor(c, LEAD, WS), { ok: false, reason: "suppressed" });
});

Deno.test("floor blocks a lead suppressed by DOMAIN", async () => {
  const c = mockClient({
    leads: { data: { email: "lead@acme.com", unsubscribed: false }, error: null },
    campaign_suppression_list: { data: [{ kind: "domain", value: "acme.com" }], error: null },
    // deno-lint-ignore no-explicit-any
  }) as any;
  assertEquals(await coldSendFloor(c, LEAD, WS), { ok: false, reason: "suppressed" });
});

Deno.test("floor fails closed when the suppression lookup errors", async () => {
  const c = mockClient({
    leads: { data: { email: "lead@acme.com", unsubscribed: false }, error: null },
    campaign_suppression_list: { data: null, error: { message: "boom" } },
    // deno-lint-ignore no-explicit-any
  }) as any;
  assertEquals(await coldSendFloor(c, LEAD, WS), { ok: false, reason: "suppression check failed" });
});

Deno.test("floor passes a clean, unsuppressed, valid lead", async () => {
  const c = mockClient({
    leads: { data: { email: "lead@acme.com", unsubscribed: false }, error: null },
    campaign_suppression_list: noSuppression,
    // deno-lint-ignore no-explicit-any
  }) as any;
  assertEquals(await coldSendFloor(c, LEAD, WS), { ok: true });
});

// ── sendColdEmailTouch: floor + CAN-SPAM postal address, no network reached ──
const sendArgs = (
  // deno-lint-ignore no-explicit-any
  c: any,
) => ({
  supabase: c,
  supabaseUrl: "http://localhost",
  serviceKey: "svc",
  internalSecret: "sec",
  lead: { id: LEAD, email: "lead@acme.com", owner_user_id: "owner-1" },
  workspaceId: WS,
  mailProvider: "gmail" as const,
  mailAccountId: null,
  subject: "Hi",
  body: "Body",
  unsubscribeUrl: "http://localhost/u?token=x",
});

Deno.test("sendColdEmailTouch refuses (no send) when the floor blocks", async () => {
  const c = mockClient({ leads: { data: { email: "lead@acme.com", unsubscribed: true }, error: null } });
  // deno-lint-ignore no-explicit-any
  const res = await sendColdEmailTouch(sendArgs(c) as any);
  assertEquals(res.ok, false);
  assertEquals(res.reason, "lead unsubscribed");
  // Proof it short-circuited before any send: it never read the workspace address.
  assertEquals(c.calls.includes("workspaces"), false);
});

Deno.test("sendColdEmailTouch refuses when the workspace has no postal address (CAN-SPAM)", async () => {
  const c = mockClient({
    leads: { data: { email: "lead@acme.com", unsubscribed: false }, error: null },
    campaign_suppression_list: noSuppression,
    workspaces: { data: { cold_outreach_postal_address: "" }, error: null },
  });
  // deno-lint-ignore no-explicit-any
  const res = await sendColdEmailTouch(sendArgs(c) as any);
  assertEquals(res.ok, false);
  assertEquals(res.reason, "no company postal address (CAN-SPAM)");
});
