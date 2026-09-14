// BEHAVIOURAL (Unit G-B, findings 3 + QA D1/D2). Runs in `npm test`, which is
// the only suite anything in this repo actually executes — the Deno mirror at
// supabase/functions/_shared/bounceDisposition.test.ts carries the same
// cases but nothing here can run it.
//
// This calls the real decision function and asserts its RETURN VALUE. The
// disposition maps 1:1 onto what gmail-bulk-sync/index.ts then does:
//   "not_a_bounce"   -> normal processing (stored on the lead's timeline)
//   "not_about_lead" -> skip (a DSN for somebody else)
//   "transient"      -> mark seen, change NOTHING (no unsubscribe)
//   "hard_stop"      -> suppress the lead
//
// Everything here protects one outcome: a reachable human is never permanently
// opted out, and their message is never silently dropped.
import { describe, expect, it } from "vitest";
import {
  bounceDisposition,
  type BounceDisposition,
} from "../../supabase/functions/_shared/bounceDisposition.ts";

const LEAD = "ann@acme.com";
const REP = "rep@drivepilot.io";
const POSTMASTER = "postmaster@acme.com";

type Input = Parameters<typeof bounceDisposition>[0];

function verdict(over: Partial<Input>): BounceDisposition {
  return bounceDisposition({
    fromEmail: POSTMASTER,
    subject: "Undeliverable: Your quote",
    bodyText: "",
    deliveryStatusText: "",
    leadEmail: LEAD,
    headersInvolveLead: false,
    isDirectConversation: false,
    ...over,
  }).disposition;
}

// ───────────────────────────────────────────────────────────────────────────
// D1 — a live customer forwarding a bounce must not be opted out, and must not
// vanish. Before the fix this returned "hard_stop" (basis "code", read out of
// the quoted forward), which set unsubscribed = true AND dropped the message.
// ───────────────────────────────────────────────────────────────────────────
const FORWARDED_BOUNCE_BODY = [
  "Hi - your mail to my colleague bounced, please resend it to me.",
  "",
  "---------- Forwarded message ----------",
  "Final-Recipient: rfc822; bob@acme.com",
  "Status: 5.1.1",
  "Diagnostic-Code: smtp; 550 5.1.1 User unknown",
].join("\n");

describe("D1: a human forwarding a bounce is not a bounce", () => {
  it("the LEAD forwards a bounce (RFC-2822 display name in From)", () => {
    expect(verdict({
      fromEmail: `Ann Smith <${LEAD}>`,
      subject: "Fwd: Undeliverable: Your quote",
      bodyText: FORWARDED_BOUNCE_BODY,
      headersInvolveLead: true,
    })).toBe("not_a_bounce");
  });

  it("the LEAD forwards a bounce (bare address in From)", () => {
    expect(verdict({
      fromEmail: LEAD,
      subject: "Fwd: Undeliverable: Your quote",
      bodyText: FORWARDED_BOUNCE_BODY,
      headersInvolveLead: true,
    })).toBe("not_a_bounce");
  });

  it("the REP forwards a bounce to the lead (passes the rep↔lead gate)", () => {
    expect(verdict({
      fromEmail: REP,
      subject: "Re: Undeliverable: Your quote",
      bodyText: FORWARDED_BOUNCE_BODY,
      headersInvolveLead: true,
      isDirectConversation: true,
    })).toBe("not_a_bounce");
  });

  it("any message that passed the rep↔lead gate is human mail, DSN wording or not", () => {
    expect(verdict({
      fromEmail: LEAD,
      subject: "delivery failure on our side - resend?",
      bodyText: "Our server had a delivery failure yesterday. Status: 5.1.1 was the code.",
      headersInvolveLead: true,
      isDirectConversation: true,
    })).toBe("not_a_bounce");
  });

  it("but a REAL DSN — postmaster sender, failing the gate — is still classified", () => {
    // The guard must not have disarmed hard-bounce detection.
    expect(verdict({
      fromEmail: `Mail Delivery Subsystem <${POSTMASTER}>`,
      subject: "Undeliverable: Your quote",
      bodyText: `Your message to ${LEAD} could not be delivered.`,
      deliveryStatusText: `Final-Recipient: rfc822; ${LEAD}\nStatus: 5.1.1`,
    })).toBe("hard_stop");
  });

  it("the carve-out holds: a lead whose own address IS the postmaster address still classifies", () => {
    // detectBounce's reason is "from" here, so the human-mail guard stands down.
    expect(verdict({
      fromEmail: POSTMASTER,
      subject: "Your quote",
      bodyText: `Your message to ${POSTMASTER} could not be delivered.\nStatus: 5.1.1`,
      leadEmail: POSTMASTER,
      headersInvolveLead: true,
    })).toBe("hard_stop");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D2 — attribution must be whole-address. A substring test stopped the WRONG
// lead: a DSN naming only joann@acme.com was attributed to ann@acme.com.
// ───────────────────────────────────────────────────────────────────────────
describe("D2: DSN attribution is whole-address, never substring", () => {
  it("a DSN for joann@ is not attributed to lead ann@", () => {
    expect(verdict({
      bodyText: "Your message to joann@acme.com could not be delivered. Status: 5.1.1",
      leadEmail: "ann@acme.com",
    })).toBe("not_about_lead");
  });

  it("a DSN for no-reply-sales@ is not attributed to lead sales@", () => {
    expect(verdict({
      bodyText: "Your message to no-reply-sales@acme.com failed. Status: 5.1.1",
      leadEmail: "sales@acme.com",
    })).toBe("not_about_lead");
  });

  it("the body substring cannot override a delivery-status part naming someone else", () => {
    expect(verdict({
      bodyText: "Delivery to joann@acme.com failed.",
      deliveryStatusText: "Final-Recipient: rfc822; joann@acme.com\nStatus: 5.1.1",
      leadEmail: "ann@acme.com",
    })).toBe("not_about_lead");
  });

  it("control: the same DSN for a lead that is not a substring at all", () => {
    expect(verdict({
      bodyText: "Your message to joann@acme.com could not be delivered. Status: 5.1.1",
      leadEmail: "zann@acme.com",
    })).toBe("not_about_lead");
  });

  it("an exact match in the human body still attributes", () => {
    expect(verdict({
      bodyText: `Your message to ${LEAD} could not be delivered.\nStatus: 5.1.1`,
    })).toBe("hard_stop");
  });

  it("an exact match in the delivery-status part alone still attributes", () => {
    expect(verdict({
      bodyText: "Your message wasn't delivered.",
      deliveryStatusText: `Final-Recipient: rfc822; ${LEAD}\nStatus: 5.1.1`,
    })).toBe("hard_stop");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The original finding-3 cases: soft never burns a lead, hard still stops one.
// ───────────────────────────────────────────────────────────────────────────
describe("soft vs hard", () => {
  it("a 4.x.x transient bounce does NOT opt the lead out", () => {
    expect(verdict({
      bodyText: `Your message to ${LEAD} could not be delivered.`,
      deliveryStatusText: `Final-Recipient: rfc822; ${LEAD}\nStatus: 4.2.2\nDiagnostic-Code: smtp; 452 Mailbox full`,
    })).toBe("transient");
  });

  it("an unclassifiable DSN falls back to transient (never burn a good lead)", () => {
    expect(verdict({
      bodyText: `Delivery to ${LEAD} was delayed. We will keep trying.`,
    })).toBe("transient");
  });

  it("a permanent-failure phrase with no status code stops the lead", () => {
    expect(verdict({ bodyText: `550 ${LEAD}: no such user here` })).toBe("hard_stop");
  });

  it("a normal reply from the lead is not a bounce", () => {
    expect(verdict({
      fromEmail: LEAD,
      subject: "Re: Quick question",
      bodyText: "Sounds good, Tuesday works.",
      isDirectConversation: true,
    })).toBe("not_a_bounce");
  });

  it("the hard verdict reports the code that decided it", () => {
    const r = bounceDisposition({
      fromEmail: POSTMASTER,
      subject: "Undeliverable",
      bodyText: "",
      deliveryStatusText: `Final-Recipient: rfc822; ${LEAD}\nStatus: 5.1.1`,
      leadEmail: LEAD,
      headersInvolveLead: true,
      isDirectConversation: false,
    });
    expect(r.disposition).toBe("hard_stop");
    expect(r.statusCode).toBe("5.1.1");
    expect(r.basis).toBe("code");
  });
});
