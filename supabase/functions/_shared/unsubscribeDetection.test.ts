// Run: deno test supabase/functions/_shared/unsubscribeDetection.test.ts
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { isHumanUnsubscribeRequest, stripQuotedReply } from "./unsubscribeDetection.ts";

/** Mirrors the call-site contract: strip quotes, lowercase, then detect. */
function detects(body: string): boolean {
  return isHumanUnsubscribeRequest(stripQuotedReply(body).toLowerCase());
}

Deno.test("genuine opt-out above quoted thread still fires", () => {
  const body = [
    "Please remove me from your list, thanks.",
    "",
    "On Mon, Jun 8, 2026 at 3:00 PM DrivePilot <rep@drivepilot.io> wrote:",
    "> Hi Ryan, just following up so you stop emailing people who already wrote back.",
  ].join("\n");
  assertEquals(detects(body), true);
});

Deno.test("bare 'unsubscribe' reply still fires", () => {
  assertEquals(detects("Unsubscribe\n\nOn ... wrote:\n> pitch"), true);
});

Deno.test("REGRESSION: our quoted pitch does NOT self-trigger (Gmail attribution)", () => {
  const body = [
    "Sounds good, let's chat Thursday.",
    "",
    "On Mon, Jun 8, 2026 at 3:00 PM DrivePilot <rep@drivepilot.io> wrote:",
    "> ...so you stop emailing people who already wrote back. Want to grab time?",
  ].join("\n");
  assertEquals(detects(body), false);
});

Deno.test("REGRESSION: quoted pitch in Outlook header-block form does NOT self-trigger", () => {
  const body = [
    "Thanks, talk soon.",
    "",
    "From: DrivePilot <rep@drivepilot.io>",
    "Sent: Monday, June 8, 2026 3:00 PM",
    "To: Ryan Frankel <ryan@example.com>",
    "Subject: Following up",
    "",
    "...so you stop emailing people who already wrote back.",
  ].join("\n");
  assertEquals(detects(body), false);
});

Deno.test("REGRESSION: quoted pitch with no new text returns no opt-out", () => {
  // Sender forwarded/quoted only; typed nothing → must not flag.
  const body = [
    "On Mon, Jun 8, 2026 at 3:00 PM DrivePilot <rep@drivepilot.io> wrote:",
    "> ...so you stop emailing people who already wrote back.",
  ].join("\n");
  assertEquals(stripQuotedReply(body), "");
  assertEquals(detects(body), false);
});

Deno.test("REGRESSION: a flattened (newline-stripped) body defeats quote-stripping", () => {
  // The Outlook-webhook bug (PR #68 follow-up): htmlToPlainText collapsed ALL whitespace —
  // including newlines — to single spaces before calling stripQuotedReply. The markers are
  // line-anchored, so a one-line body strips nothing and our own quoted pitch self-triggers.
  // This pins the contract: callers MUST feed newline-preserving text. processor.ts now does
  // (htmlToPlainText(..., preserveNewlines=true) for the unsubscribe path).
  const multiline = [
    "Thanks, talk soon.",
    "",
    "On Mon, Jun 8, 2026 at 3:00 PM DrivePilot <rep@drivepilot.io> wrote:",
    "> ...so you stop emailing people who already wrote back.",
  ].join("\n");
  const flattened = multiline.replace(/\s+/g, " "); // what the OLD htmlToPlainText produced
  assertEquals(detects(flattened), true);  // bug form: quote not stripped → false positive
  assertEquals(detects(multiline), false); // fixed form: newlines preserved → quote stripped
});

Deno.test("plain single-message body is unaffected", () => {
  assertEquals(stripQuotedReply("Hi, can you send pricing?"), "Hi, can you send pricing?");
  assertEquals(detects("Hi, can you send pricing?"), false);
});

Deno.test("opt-out below '>' plain-text quote is dropped (safe direction)", () => {
  // Bottom-posted opt-out under a quote is a tolerated false-negative:
  // the inbound is still visible to the rep; we never silently kill automation.
  const body = "> earlier pitch\n> stop emailing\nremove me";
  assertEquals(stripQuotedReply(body), "");
});
