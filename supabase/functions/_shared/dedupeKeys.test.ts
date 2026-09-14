// Run: deno test supabase/functions/_shared/dedupeKeys.test.ts
//
// BEHAVIOURAL. Deno mirror of src/test/outlookDedupeKey.test.ts.
//
// THE BUG: both Outlook writers were unified onto `outlook:<Message-ID>`. That
// fixed the "same email stored twice" defect and created a worse one: the RFC
// 2822 Message-ID is GLOBAL. When one sender emails two DrivePilot customers,
// both copies carry the same Message-ID, and `interactions.dedupe_key` is
// globally unique — so the second workspace's insert raised 23505,
// `createCanonicalInteraction` resolved it to the FIRST workspace's interaction
// row, and projected that foreign interaction id into the second lead's
// timeline. A cross-tenant write.
//
// The "two tenants" test is the one that fails if the scope is removed. The
// database half of the proof — that the unique index actually rejects the
// unscoped key and accepts the scoped one — is in
// supabase/tests/outlook_dedupe_key_scope.test.sql, against real Postgres.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";

let currentSuite = "";
function describe(name: string, body: () => void) { currentSuite = name; body(); currentSuite = ""; }
function it(name: string, fn: () => void) { Deno.test(`${currentSuite} > ${name}`, fn); }
const expect = (actual: any) => ({
  toBe: (e: unknown) => assertEquals(actual, e),
  not: { toBe: (e: unknown) => assertEquals(actual === e, false) },
});
import {
  isOutlookKeyForLead,
  outlookEmailDedupeKey,
} from "./dedupeKeys.ts";

const MSG_ID = "<AAB1C2D3@acme.com>";
const GRAPH_A = "AAMkAGI2-mailbox-a";
const GRAPH_B = "AAMkAGI2-mailbox-b";
const LEAD_A = "11111111-1111-1111-1111-111111111111";
const LEAD_B = "22222222-2222-2222-2222-222222222222";

describe("two tenants receiving the same Message-ID", () => {
  it("THE REGRESSION — the same Message-ID on two leads produces two different keys", () => {
    // Same email, delivered to two connected mailboxes in two workspaces. Graph
    // gives each mailbox its own message id, but the Message-ID is shared.
    const tenantA = outlookEmailDedupeKey(LEAD_A, MSG_ID, GRAPH_A, GRAPH_A);
    const tenantB = outlookEmailDedupeKey(LEAD_B, MSG_ID, GRAPH_B, GRAPH_B);
    expect(tenantA).not.toBe(tenantB);
  });

  it("holds for the graph fallback too", () => {
    expect(outlookEmailDedupeKey(LEAD_A, null, GRAPH_A, "x"))
      .not.toBe(outlookEmailDedupeKey(LEAD_B, null, GRAPH_A, "x"));
  });

  it("holds for the interaction fallback too", () => {
    expect(outlookEmailDedupeKey(LEAD_A, null, null, "same-interaction"))
      .not.toBe(outlookEmailDedupeKey(LEAD_B, null, null, "same-interaction"));
  });

  it("a rep emailing two leads at one company does not collapse them either", () => {
    // Same workspace, one message, two legitimate direct conversations. Workspace
    // scoping would still collide here; lead scoping does not.
    expect(outlookEmailDedupeKey(LEAD_A, MSG_ID, GRAPH_A, GRAPH_A))
      .not.toBe(outlookEmailDedupeKey(LEAD_B, MSG_ID, GRAPH_A, GRAPH_A));
  });
});

describe("the webhook and the sync still collapse onto one row", () => {
  it("both paths produce the same key for the same message on the same lead", () => {
    // outlook-sync passes (leadId, internetMessageId, graph id, fallback id);
    // outlook-webhook passes (leadId, internetMessageId, graph id, graph id).
    const fromSync = outlookEmailDedupeKey(LEAD_A, MSG_ID, GRAPH_A, "interaction-uuid");
    const fromWebhook = outlookEmailDedupeKey(LEAD_A, MSG_ID, GRAPH_A, GRAPH_A);
    expect(fromSync).toBe(fromWebhook);
    expect(fromSync).toBe(`outlook:${LEAD_A}:${MSG_ID}`);
  });

  it("they still agree when Graph gives no internetMessageId", () => {
    expect(outlookEmailDedupeKey(LEAD_A, null, GRAPH_A, "interaction-uuid"))
      .toBe(outlookEmailDedupeKey(LEAD_A, null, GRAPH_A, GRAPH_A));
  });
});

describe("key shape", () => {
  it("the graph fallback is namespaced away from the Message-ID form", () => {
    expect(outlookEmailDedupeKey(LEAD_A, null, GRAPH_A, "x"))
      .not.toBe(outlookEmailDedupeKey(LEAD_A, GRAPH_A, null, "x"));
  });

  it("no key is ever the legacy unscoped or webhook shape", () => {
    for (
      const key of [
        outlookEmailDedupeKey(LEAD_A, MSG_ID, GRAPH_A, "x"),
        outlookEmailDedupeKey(LEAD_A, null, GRAPH_A, "x"),
        outlookEmailDedupeKey(LEAD_A, null, null, "x"),
      ]
    ) {
      expect(key.startsWith("outlook:webhook:")).toBe(false);
      // The legacy shape put the message id straight after the prefix.
      expect(key.startsWith(`outlook:${MSG_ID}`)).toBe(false);
      expect(isOutlookKeyForLead(key, LEAD_A)).toBe(true);
      expect(isOutlookKeyForLead(key, LEAD_B)).toBe(false);
    }
  });
});
