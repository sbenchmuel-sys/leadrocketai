// Run: deno test supabase/functions/gmail-bulk-sync/bounceDisposition.test.ts
//
// BEHAVIOURAL. Calls the real decision function and asserts what it RETURNS.
// The disposition maps 1:1 onto what index.ts then does:
//   "not_a_bounce"   -> normal processing (store as inbound/outbound)
//   "not_about_lead" -> skip entirely
//   "transient"      -> mark seen, change NOTHING (no unsubscribe, no store)
//   "hard_stop"      -> suppress the lead, and still NOT store as outbound
//
// Regression under test (Unit G-B P1): every one of these used to return the
// equivalent of "hard_stop" AND then be stored as `email_outbound`.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { bounceDisposition } from "./bounceDisposition.ts";

const LEAD = "manu@acme.com";
const POSTMASTER = "postmaster@acme.com";

function d(over: Partial<Parameters<typeof bounceDisposition>[0]>) {
  return bounceDisposition({
    fromEmail: POSTMASTER,
    subject: "Undeliverable: Quick question",
    bodyText: "",
    deliveryStatusText: "",
    leadEmail: LEAD,
    headersInvolveLead: false,
    ...over,
  }).disposition;
}

// ── the customer-burning regression ────────────────────────────────────────
Deno.test("SOFT 4.x.x bounce for this lead is transient — the lead is NOT opted out", () => {
  assertEquals(
    d({
      bodyText: `Your message to ${LEAD} could not be delivered.`,
      deliveryStatusText: `Final-Recipient: rfc822; ${LEAD}\nStatus: 4.2.2\nDiagnostic-Code: smtp; 452 Mailbox full`,
    }),
    "transient",
  );
});

Deno.test("out-of-office wording that trips the DSN subject list is still only transient", () => {
  assertEquals(
    d({
      fromEmail: LEAD,
      subject: "Undeliverable: I am out of the office",
      bodyText: `I am away until Monday. ${LEAD}`,
    }),
    "transient",
  );
});

Deno.test("a DSN with no status code and no permanent phrase is transient (fail-safe)", () => {
  assertEquals(
    d({ bodyText: `Delivery to ${LEAD} was delayed. We will keep trying.` }),
    "transient",
  );
});

// ── genuine permanent failures still stop the lead ─────────────────────────
Deno.test("HARD 5.1.1 in the delivery-status part stops the lead", () => {
  assertEquals(
    d({
      bodyText: "Your message wasn't delivered.",
      deliveryStatusText: `Final-Recipient: rfc822; ${LEAD}\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 User unknown`,
    }),
    "hard_stop",
  );
});

Deno.test("HARD permanent phrase with no status code stops the lead", () => {
  assertEquals(
    d({ bodyText: `550 ${LEAD}: no such user here` }),
    "hard_stop",
  );
});

// ── attribution ────────────────────────────────────────────────────────────
Deno.test("a bounce for a DIFFERENT recipient is not attributed to this lead", () => {
  assertEquals(
    d({
      bodyText: "Your message wasn't delivered.",
      deliveryStatusText: "Final-Recipient: rfc822; someone-else@other.com\nStatus: 5.1.1",
    }),
    "not_about_lead",
  );
});

Deno.test("delivery-status part alone is enough to attribute (human body names nobody)", () => {
  assertEquals(
    d({
      bodyText: "Your message wasn't delivered.",
      deliveryStatusText: `Final-Recipient: rfc822; ${LEAD}\nStatus: 5.1.1`,
    }),
    "hard_stop",
  );
});

Deno.test("a near-miss address does not attribute (joann@ vs ann@)", () => {
  assertEquals(
    bounceDisposition({
      fromEmail: POSTMASTER,
      subject: "Undeliverable",
      bodyText: "Your message wasn't delivered.",
      deliveryStatusText: "Final-Recipient: rfc822; joann@acme.com\nStatus: 5.1.1",
      leadEmail: "ann@acme.com",
      headersInvolveLead: false,
    }).disposition,
    "not_about_lead",
  );
});

// ── ordinary mail is untouched ─────────────────────────────────────────────
Deno.test("a normal reply from the lead is not a bounce", () => {
  assertEquals(
    d({ fromEmail: LEAD, subject: "Re: Quick question", bodyText: "Sounds good, Tuesday works." }),
    "not_a_bounce",
  );
});

Deno.test("the hard verdict reports the code that decided it", () => {
  const r = bounceDisposition({
    fromEmail: POSTMASTER,
    subject: "Undeliverable",
    bodyText: "",
    deliveryStatusText: `Final-Recipient: rfc822; ${LEAD}\nStatus: 5.1.1`,
    leadEmail: LEAD,
    headersInvolveLead: true,
  });
  assertEquals(r.disposition, "hard_stop");
  assertEquals(r.statusCode, "5.1.1");
  assertEquals(r.basis, "code");
});
