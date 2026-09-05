// Run: deno test supabase/functions/_shared/coldSendFloor.test.ts
//
// Exercises the REAL fail-closed floor (coldSendFloor + sendColdEmailTouch) against
// a mock supabase client — no refactor of the orchestration, no live DB, no network.
// The floor is the last line before a cold email reaches a real person, so every
// blocked condition must FAIL CLOSED (return ok:false / refuse to send), and the
// happy path must pass. The pure sub-rules (email-validity, suppression matching)
// are additionally unit-tested in src/lib/__tests__/coldSendFloorRules.test.ts.
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { coldSendFloor, sendColdEmailTouch, requirePostalAddress } from "./coldOutreach.ts";
import { buildColdEmailFooter } from "./coldEmailFooter.ts";

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

// CAN-SPAM postal address. The hard refusal was relaxed for the closed pilot and
// is now the explicit COLD_REQUIRE_POSTAL_ADDRESS switch (see requirePostalAddress
// in coldOutreach.ts). Both sides are covered here, so flipping the secret needs no
// test change — and leaving it off can never again go unnoticed.
const blankPostalWorkspace = () =>
  mockClient({
    leads: { data: { email: "lead@acme.com", unsubscribed: false }, error: null },
    campaign_suppression_list: noSuppression,
    workspaces: { data: { cold_outreach_postal_address: "" }, error: null },
  });

Deno.test("PILOT (switch off): a blank postal address does NOT refuse the send", async () => {
  Deno.env.delete("COLD_REQUIRE_POSTAL_ADDRESS");
  const c = blankPostalWorkspace();
  // deno-lint-ignore no-explicit-any
  const res = await sendColdEmailTouch(sendArgs(c) as any);
  // It read the workspace and carried on past the postal check — whatever stops it
  // next (here: no connected Gmail in the mock), it is NOT the postal address.
  assertEquals(c.calls.includes("workspaces"), true);
  assertNotEquals(res.reason, "no company postal address (CAN-SPAM)");
});

Deno.test("switch ON: a blank postal address refuses the send (CAN-SPAM)", async () => {
  Deno.env.set("COLD_REQUIRE_POSTAL_ADDRESS", "true");
  try {
    const c = blankPostalWorkspace();
    // deno-lint-ignore no-explicit-any
    const res = await sendColdEmailTouch(sendArgs(c) as any);
    assertEquals(res.ok, false);
    assertEquals(res.reason, "no company postal address (CAN-SPAM)");
    // Proof it short-circuited before any send path.
    assertEquals(c.calls.includes("gmail_connections"), false);
  } finally {
    Deno.env.delete("COLD_REQUIRE_POSTAL_ADDRESS");
  }
});

Deno.test("the switch needs an explicit \"true\" — a typo leaves the pilot behaviour, never a silent block", () => {
  try {
    for (const on of ["true", "TRUE", " True "]) {
      Deno.env.set("COLD_REQUIRE_POSTAL_ADDRESS", on);
      assertEquals(requirePostalAddress(), true);
    }
    for (const off of ["", "1", "yes", "false", "ture"]) {
      Deno.env.set("COLD_REQUIRE_POSTAL_ADDRESS", off);
      assertEquals(requirePostalAddress(), false);
    }
    Deno.env.delete("COLD_REQUIRE_POSTAL_ADDRESS");
    assertEquals(requirePostalAddress(), false);
  } finally {
    Deno.env.delete("COLD_REQUIRE_POSTAL_ADDRESS");
  }
});

// The footer is the actual CAN-SPAM mechanism, so lock what it emits either way:
// the unsubscribe link is unconditional; the address line appears only when set.
Deno.test("footer always carries the unsubscribe link, and the address line only when present", () => {
  const withAddr = buildColdEmailFooter({ unsubscribeUrl: "http://x/u?t=1", postalAddress: "1 Main St, Springfield" });
  assertEquals(withAddr.footerText.includes("http://x/u?t=1"), true);
  assertEquals(withAddr.footerText.includes("1 Main St, Springfield"), true);

  const blank = buildColdEmailFooter({ unsubscribeUrl: "http://x/u?t=1", postalAddress: "" });
  assertEquals(blank.footerText.includes("http://x/u?t=1"), true);
  // No empty address line, no placeholder — just absent.
  assertEquals(blank.footerText.trimEnd().endsWith("http://x/u?t=1"), true);
});
