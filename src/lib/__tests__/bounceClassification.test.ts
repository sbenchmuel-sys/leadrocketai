import { describe, it, expect } from "vitest";
// Pure leaf module — zero server-only imports, so it loads cleanly under vitest.
import { classifyBounce } from "../../../supabase/functions/_shared/bounceDetection";

// These guard the exact gate that gmail-sync / outlook-sync apply: the caller
// permanently suppresses the lead + ends the enrollment + counts the bounce
// circuit breaker ONLY when severity === "hard". Anything else leaves the lead
// alone to retry. Pinning the classifier here keeps that gate from regressing.
describe("classifyBounce — soft vs hard gate", () => {
  it("4.x.x soft bounce → soft (caller must NOT unsubscribe or end the enrollment)", () => {
    expect(classifyBounce({ subject: "Delivery delayed", body: "Status: 4.4.7" }).severity).toBe("soft");
    expect(
      classifyBounce({ body: "450 4.2.1 Mailbox full, try again later" }).severity,
    ).toBe("soft");
  });

  it("5.x.x hard bounce → hard (caller suppresses + ends enrollment + counts breaker)", () => {
    expect(classifyBounce({ subject: "Undeliverable", body: "Status: 5.1.1" }).severity).toBe("hard");
    expect(
      classifyBounce({ body: "550 5.1.1 The email account that you tried to reach does not exist." })
        .severity,
    ).toBe("hard");
  });

  it("no Status code → falls back to keyword behavior", () => {
    // Clearly-permanent phrase, no code → hard via keyword fallback.
    const permanent = classifyBounce({ subject: "Mail delivery failed", body: "no such user" });
    expect(permanent.severity).toBe("hard");
    expect(permanent.basis).toBe("keyword");
  });

  it("unclassifiable / ambiguous bounce → soft (fail-safe: the lead survives)", () => {
    const ambiguous = classifyBounce({
      subject: "Delivery Status Notification (Failure)",
      body: "This is an automatically generated Delivery Status Notification.",
    });
    expect(ambiguous.severity).toBe("soft");
    expect(ambiguous.basis).toBe("fallback");
  });

  it("an enhanced code beats scary keyword wording (prefer the code)", () => {
    // 4.x.x present despite the word 'failure' → soft, not hard.
    expect(classifyBounce({ subject: "failure notice", body: "Status: 4.3.0" }).severity).toBe("soft");
  });

  it("most-severe code wins when several are present (5 outranks 4)", () => {
    expect(classifyBounce({ body: "Status: 4.4.7\nStatus: 5.1.1" }).severity).toBe("hard");
  });

  it("bare 3-digit SMTP reply code (no enhanced code) is honored by class", () => {
    // 5yz = permanent, 4yz = transient, when no X.Y.Z enhanced code is present.
    expect(
      classifyBounce({ body: "Diagnostic-Code: smtp; 550 mailbox unavailable" }).severity,
    ).toBe("hard");
    expect(
      classifyBounce({ body: "Diagnostic-Code: smtp; 451 try again later" }).severity,
    ).toBe("soft");
  });

  it("multi-recipient DSN: a soft recipient is NOT burned by another recipient's hard code", () => {
    // One report, two recipients: ben hard (5.1.1), gina soft (4.4.7). Scoped to
    // the lead's own per-recipient block so gina survives. (Codex P2 on PR #89.)
    const dsn = [
      "Final-Recipient: rfc822; ben@acme.com",
      "Action: failed",
      "Status: 5.1.1",
      "",
      "Final-Recipient: rfc822; gina@acme.com",
      "Action: delayed",
      "Status: 4.4.7",
    ].join("\n");
    expect(classifyBounce({ body: dsn, recipientEmail: "ben@acme.com" }).severity).toBe("hard");
    expect(classifyBounce({ body: dsn, recipientEmail: "gina@acme.com" }).severity).toBe("soft");
  });

  it("aliased recipient: Original-Recipient + Final-Recipient stay in one group", () => {
    // The lead was addressed as lead@acme.com but forwarding rewrote the Final-
    // Recipient; the 5.1.1 Status sits after Final-Recipient in the SAME group.
    // Scoping must keep them together so the hard bounce isn't lost. (Codex P2 r2.)
    const dsn = [
      "Final-Recipient: rfc822; bystander@other.com",
      "Action: delayed",
      "Status: 4.4.7",
      "",
      "Original-Recipient: rfc822; lead@acme.com",
      "Final-Recipient: rfc822; lead-alias@forwarder.net",
      "Action: failed",
      "Status: 5.1.1",
    ].join("\n");
    expect(classifyBounce({ body: dsn, recipientEmail: "lead@acme.com" }).severity).toBe("hard");
    expect(classifyBounce({ body: dsn, recipientEmail: "bystander@other.com" }).severity).toBe("soft");
  });

  it("matches recipients exactly so a suffix address isn't burned by another's code", () => {
    // ann@example.com is a suffix of joann@example.com; exact matching keeps
    // ann's 4.x.x from being upgraded to joann's 5.x.x. (Codex P2 round 3.)
    const dsn = [
      "Final-Recipient: rfc822; joann@example.com",
      "Status: 5.1.1",
      "",
      "Final-Recipient: rfc822; ann@example.com",
      "Status: 4.4.7",
    ].join("\n");
    expect(classifyBounce({ body: dsn, recipientEmail: "ann@example.com" }).severity).toBe("soft");
    expect(classifyBounce({ body: dsn, recipientEmail: "joann@example.com" }).severity).toBe("hard");
  });

  it("honors a canonical Status: code when the human text has no inline code (P1 contract)", () => {
    const body = "Your message couldn't be delivered.\n\nFinal-Recipient: rfc822; dead@acme.com\nStatus: 5.2.1";
    expect(classifyBounce({ body, recipientEmail: "dead@acme.com" }).severity).toBe("hard");
  });
});
