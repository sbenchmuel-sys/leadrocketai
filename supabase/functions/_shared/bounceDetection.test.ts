// Run: deno test supabase/functions/_shared/bounceDetection.test.ts
//
// Guards the soft-vs-hard bounce gate. A SOFT (transient) bounce must NOT cause
// the caller to suppress the lead / end the cadence; a HARD (permanent) bounce
// must. These pure-function tests pin the classification so the gate in
// gmail-sync / outlook-sync can't silently regress.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  classifyBounce,
  detectBounce,
  type BounceSeverity,
} from "./bounceDetection.ts";

function severityOf(opts: { subject?: string; body?: string; fromEmail?: string }): BounceSeverity {
  return classifyBounce(opts).severity;
}

// ── 4.x.x transient → soft (do NOT burn the lead) ──────────────────────────
Deno.test("4.x.x via canonical Status: field → soft", () => {
  assertEquals(severityOf({ subject: "Delivery delayed", body: "Action: delayed\nStatus: 4.4.7\n" }), "soft");
});

Deno.test("4.x.x inline after SMTP reply code → soft", () => {
  const body = "The response from the remote server was:\n450 4.2.1 Mailbox is full, try again later";
  assertEquals(severityOf({ body }), "soft");
});

Deno.test("greylisting 4.7.x → soft", () => {
  assertEquals(severityOf({ body: "421 4.7.0 Greylisted, please try again in 5 minutes" }), "soft");
});

// ── 5.x.x permanent → hard (suppress + end + count breaker) ─────────────────
Deno.test("5.x.x via canonical Status: field → hard", () => {
  assertEquals(severityOf({ subject: "Undeliverable", body: "Action: failed\nStatus: 5.1.1\n" }), "hard");
});

Deno.test("5.x.x inline after SMTP reply code → hard", () => {
  const body = "The response was:\n550 5.1.1 The email account that you tried to reach does not exist.";
  assertEquals(severityOf({ body }), "hard");
});

Deno.test("5.x.x with `#` separator (Outlook style) → hard", () => {
  assertEquals(severityOf({ body: "Remote Server returned '550 #5.1.10 RESOLVER.ADR.RecipNotFound'" }), "hard");
});

// ── No status code → keyword fallback ───────────────────────────────────────
Deno.test("no code but a clearly-permanent phrase → hard (keyword fallback)", () => {
  const r = classifyBounce({ subject: "Mail delivery failed", body: "Sorry, no such user here." });
  assertEquals(r.severity, "hard");
  assertEquals(r.basis, "keyword");
  assertEquals(r.statusCode, null);
});

Deno.test("no code, only generic DSN wording → soft (fail-safe, ambiguous)", () => {
  // "Undeliverable" / "delivery status notification" alone is NOT enough to
  // permanently kill a lead — when in doubt, keep the lead.
  const r = classifyBounce({
    subject: "Delivery Status Notification (Failure)",
    body: "This is an automatically generated Delivery Status Notification.",
  });
  assertEquals(r.severity, "soft");
  assertEquals(r.basis, "fallback");
});

// ── Code wins over keyword, most-severe wins across multiple codes ──────────
Deno.test("4.x.x code present even with scary 'failed' wording → soft (code beats keyword)", () => {
  assertEquals(severityOf({ subject: "failure notice", body: "Action: delayed\nStatus: 4.3.0" }), "soft");
});

Deno.test("both 4.x.x and 5.x.x present → hard (5 outranks 4)", () => {
  const body = "Status: 4.4.7\n--- next recipient ---\nStatus: 5.1.1";
  assertEquals(severityOf({ body }), "hard");
});

Deno.test("2.x.x success line ignored; 5.x.x decides → hard", () => {
  const body = "Status: 2.1.5 (delivered)\nStatus: 5.2.1 (mailbox disabled)";
  assertEquals(severityOf({ body }), "hard");
});

// ── False-positive guards ───────────────────────────────────────────────────
Deno.test("a version-like token not adjacent to a reply code is NOT a status code", () => {
  // "5.1.1" here is a product version, not a DSN code, and there's no permanent
  // phrase → fail-safe soft.
  assertEquals(severityOf({ body: "Mailer version 5.1.1 deferred your message temporarily." }), "soft");
});

Deno.test("empty / missing input → soft", () => {
  assertEquals(severityOf({}), "soft");
  assertEquals(severityOf({ subject: "", body: "" }), "soft");
});

// ── Realistic provider DSN bodies ───────────────────────────────────────────
Deno.test("realistic Gmail permanent NDR → hard", () => {
  const body = [
    "** Address not found **",
    "",
    "Your message wasn't delivered to nope@example.com because the address couldn't be found.",
    "",
    "The response from the remote server was:",
    "550 5.1.1 The email account that you tried to reach does not exist.",
  ].join("\n");
  assertEquals(severityOf({ subject: "Delivery Status Notification (Failure)", body }), "hard");
});

Deno.test("realistic Gmail delayed (transient) warning → soft", () => {
  const body = [
    "** Message delayed **",
    "",
    "Your message to busy@example.com has been delayed. Gmail will keep trying.",
    "",
    "The response from the remote server was:",
    "452 4.2.2 The recipient's mailbox is over its storage limit.",
  ].join("\n");
  assertEquals(severityOf({ subject: "Delivery Status Notification (Delay)", body }), "soft");
});

Deno.test("realistic Outlook permanent NDR → hard", () => {
  const body = "Your message to gone@contoso.com couldn't be delivered.\n" +
    "Remote Server returned '550 5.1.1 RESOLVER.ADR.RecipNotFound; Recipient not found'";
  assertEquals(severityOf({ subject: "Undeliverable: Quick question", body }), "hard");
});

// ── Multi-recipient DSN: classify only THIS recipient's block ───────────────
// A single report can list several failed recipients with different severities.
// Without scoping, a global "5 outranks 4" scan would burn a recoverable lead
// whose own failure was transient, just because another recipient hard-failed.
const MULTI_RECIPIENT_DSN = [
  "Final-Recipient: rfc822; ben@acme.com",
  "Action: failed",
  "Status: 5.1.1",
  "Diagnostic-Code: smtp; 550 5.1.1 User unknown",
  "",
  "Final-Recipient: rfc822; gina@acme.com",
  "Action: delayed",
  "Status: 4.4.7",
  "Diagnostic-Code: smtp; 452 4.4.7 Mailbox is full",
].join("\n");

Deno.test("multi-recipient DSN: this lead's 5.x.x block → HARD", () => {
  assertEquals(classifyBounce({ body: MULTI_RECIPIENT_DSN, recipientEmail: "ben@acme.com" }).severity, "hard");
});

Deno.test("multi-recipient DSN: soft recipient stays SOFT despite another recipient's 5.x.x", () => {
  // gina is 4.4.7; ben in the SAME report is 5.1.1. Scoped to gina → soft.
  assertEquals(classifyBounce({ body: MULTI_RECIPIENT_DSN, recipientEmail: "gina@acme.com" }).severity, "soft");
});

Deno.test("single-recipient DSN is unchanged by scoping (no false narrowing)", () => {
  assertEquals(
    classifyBounce({ body: "Final-Recipient: rfc822; solo@acme.com\nStatus: 5.2.1", recipientEmail: "solo@acme.com" })
      .severity,
    "hard",
  );
});

// Aliased recipient: Original-Recipient (what we addressed) + Final-Recipient
// (after forwarding) live in the SAME group, ahead of the Status. Scoping must
// keep them together so the lead's 5.x.x isn't lost. (Codex P2 round 2 #89.)
const ALIASED_MULTI_DSN = [
  "Final-Recipient: rfc822; bystander@other.com",
  "Action: delayed",
  "Status: 4.4.7",
  "",
  "Original-Recipient: rfc822; lead@acme.com",
  "Final-Recipient: rfc822; lead-alias@forwarder.net",
  "Action: failed",
  "Status: 5.1.1",
].join("\n");

Deno.test("aliased recipient: Original+Final stay in one group → lead's 5.x.x is HARD", () => {
  assertEquals(classifyBounce({ body: ALIASED_MULTI_DSN, recipientEmail: "lead@acme.com" }).severity, "hard");
});

Deno.test("aliased report: the unrelated transient recipient is still SOFT", () => {
  assertEquals(classifyBounce({ body: ALIASED_MULTI_DSN, recipientEmail: "bystander@other.com" }).severity, "soft");
});

Deno.test("substring-collision recipients are matched exactly, not by includes (P2 round 3)", () => {
  // ann@example.com is a suffix of joann@example.com — a substring match would
  // pull joann's 5.x.x into ann's scope and burn a recoverable lead.
  const dsn = [
    "Final-Recipient: rfc822; joann@example.com",
    "Action: failed",
    "Status: 5.1.1",
    "",
    "Final-Recipient: rfc822; ann@example.com",
    "Action: delayed",
    "Status: 4.4.7",
  ].join("\n");
  assertEquals(classifyBounce({ body: dsn, recipientEmail: "ann@example.com" }).severity, "soft");
  assertEquals(classifyBounce({ body: dsn, recipientEmail: "joann@example.com" }).severity, "hard");
});

Deno.test("canonical Status: code is honored when the human text carries no inline code (P1 contract)", () => {
  // Mirrors what the gmail caller now passes: human preamble (no code) + the
  // machine delivery-status part. The Status: field must drive the decision.
  const body = [
    "Your message couldn't be delivered to the recipient. See details below.",
    "",
    "Final-Recipient: rfc822; dead@acme.com",
    "Action: failed",
    "Status: 5.2.1",
  ].join("\n");
  assertEquals(classifyBounce({ body, recipientEmail: "dead@acme.com" }).severity, "hard");
});

Deno.test("multi-recipient where lead is only in the preamble → falls back to whole body", () => {
  // No structured block names 'lead@acme.com'; scoping returns null and we
  // classify the whole body (best effort). Here the only code is 4.x.x → soft.
  const body = "Delivery to lead@acme.com and others delayed.\n" +
    "Final-Recipient: rfc822; other@acme.com\nStatus: 4.2.2";
  assertEquals(classifyBounce({ body, recipientEmail: "lead@acme.com" }).severity, "soft");
});

// ── Existing detector still works (regression) ──────────────────────────────
Deno.test("detectBounce still flags postmaster sender / DSN subject", () => {
  assertEquals(detectBounce("mailer-daemon@googlemail.com", "hi").isBounce, true);
  assertEquals(detectBounce("rep@dealer.com", "Undeliverable: Quick question").isBounce, true);
  assertEquals(detectBounce("lead@acme.com", "Re: Quick question").isBounce, false);
});
