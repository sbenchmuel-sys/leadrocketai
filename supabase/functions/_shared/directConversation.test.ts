// Run: deno test supabase/functions/_shared/directConversation.test.ts
//
// BEHAVIOURAL. Deno mirror of src/test/directConversationGate.test.ts.
// Asserts what the gate RETURNS, not what its source says.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { isDirectConversation } from "./directConversation.ts";

const LEAD = "manu@acme.com";
const REP = "rep@drivepilot.io";

Deno.test("lead → rep is kept", () => {
  assertEquals(
    isDirectConversation({ fromEmails: [LEAD], recipientEmails: [REP], leadEmail: LEAD, repEmail: REP }),
    true,
  );
});

Deno.test("rep → lead is kept", () => {
  assertEquals(
    isDirectConversation({ fromEmails: [REP], recipientEmails: [LEAD], leadEmail: LEAD, repEmail: REP }),
    true,
  );
});

Deno.test("third-party newsletter addressed to the lead is dropped", () => {
  assertEquals(
    isDirectConversation({
      fromEmails: ["news@substack.com"],
      recipientEmails: [LEAD],
      leadEmail: LEAD,
      repEmail: REP,
    }),
    false,
  );
});

Deno.test("lead → someone other than the rep is dropped", () => {
  assertEquals(
    isDirectConversation({
      fromEmails: [LEAD],
      recipientEmails: ["someone-else@acme.com"],
      leadEmail: LEAD,
      repEmail: REP,
    }),
    false,
  );
});

Deno.test("unknown rep mailbox fails CLOSED", () => {
  assertEquals(
    isDirectConversation({ fromEmails: [LEAD], recipientEmails: [REP], leadEmail: LEAD, repEmail: "" }),
    false,
  );
});

Deno.test("does not match a substring of a longer address", () => {
  assertEquals(
    isDirectConversation({
      fromEmails: ["joann@acme.com"],
      recipientEmails: [REP],
      leadEmail: "ann@acme.com",
      repEmail: REP,
    }),
    false,
  );
});
