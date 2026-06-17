import { describe, expect, it } from "vitest";
import { repliedSinceEnrollment } from "../../../supabase/functions/_shared/coldReplyStop";

// Regression test for the staggered-list reply-stop hole.
//
// The cold reply-stop check used to compare the lead's last inbound time to the
// enrollment's started_at. For a STAGGERED large list, started_at can be days in the
// future, so a reply that landed AFTER enrollment but BEFORE the staggered start day
// did NOT stop the first touch — the lead got cold-emailed despite already replying.
// The fix re-anchors the comparison to enrolled_at (when the lead was committed to the
// cadence). These tests lock that in.

describe("repliedSinceEnrollment — staggered enrollment reply-stop", () => {
  // A lead enrolled now but whose day-0 SEND anchor is staggered 5 business days out.
  const enrolledAt = "2026-06-08T09:00:00.000Z"; // committed to the cadence here
  const startedAt = "2026-06-15T09:00:00.000Z";  // staggered send anchor, a week later
  // The prospect replies the same afternoon — AFTER enrolled_at, BEFORE started_at.
  const replyDuringWait = "2026-06-08T15:30:00.000Z";

  it("STOPS the sequence for a reply that lands during the staggered pre-start wait", () => {
    // This is the bug fix: anchored at enrolled_at, the reply suppresses the first touch.
    expect(repliedSinceEnrollment(replyDuringWait, enrolledAt)).toBe(true);
  });

  it("documents the OLD behavior: anchored at the future started_at, the same reply slipped through", () => {
    // Had the call sites kept comparing to started_at, this would be false — i.e. the
    // first cold touch would still fire to someone who already wrote back. Anchoring at
    // enrolled_at (the assertion above) is what closes the hole.
    expect(repliedSinceEnrollment(replyDuringWait, startedAt)).toBe(false);
  });

  it("ignores an old/warm reply that PREDATES enrollment (don't auto-stop a re-cold lead)", () => {
    const replyBeforeEnrolling = "2026-05-01T09:00:00.000Z";
    expect(repliedSinceEnrollment(replyBeforeEnrolling, enrolledAt)).toBe(false);
  });

  it("non-staggered case (enrolled_at ≈ started_at): a later reply still stops it", () => {
    const sameAnchor = "2026-06-08T09:00:00.000Z";
    const laterReply = "2026-06-09T10:00:00.000Z";
    expect(repliedSinceEnrollment(laterReply, sameAnchor)).toBe(true);
  });

  // ── Fail-safe direction: when uncertain, suppress the touch, never send ──
  // A `true` result stops the touch; `false` lets it send. So uncertainty must lean true.

  it("no inbound on record → proceeds (genuinely never replied — the normal cold case, not uncertainty)", () => {
    // last_inbound_at is null until a real inbound lands; suppressing here would stop
    // every never-replied lead (i.e. all of cold outreach).
    expect(repliedSinceEnrollment(null, enrolledAt)).toBe(false);
    expect(repliedSinceEnrollment(undefined, enrolledAt)).toBe(false);
    expect(repliedSinceEnrollment("", enrolledAt)).toBe(false);
  });

  it("inbound PRESENT but unparseable → suppresses (we know they wrote in, can't prove when)", () => {
    expect(repliedSinceEnrollment("not-a-real-date", enrolledAt)).toBe(true);
  });

  it("inbound present but enrollment baseline missing/unparseable → suppresses (can't compare → don't send)", () => {
    expect(repliedSinceEnrollment(replyDuringWait, null)).toBe(true);
    expect(repliedSinceEnrollment(replyDuringWait, undefined)).toBe(true);
    expect(repliedSinceEnrollment(replyDuringWait, "garbage")).toBe(true);
  });
});
