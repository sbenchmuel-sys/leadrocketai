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
});
