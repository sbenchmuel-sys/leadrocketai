// Static guards for three Sprint 2 fixes whose regression is a single silent
// line — no runtime test would catch them, because each still "works", just
// wrongly. Same pattern as coldAutoSendGate.test.ts.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("outreach cadence surfaces render workspace time (#10)", () => {
  // The whole point of eligibleAtFormat.ts: a rep whose browser TZ != the
  // workspace's must not see a different due time than their colleague.
  for (const rel of [
    "src/lib/upcomingTouchesQueries.ts",
    "src/components/queue/UpcomingTouchesStrip.tsx",
    "src/components/queue/OutreachCard.tsx",
  ]) {
    it(`${rel} formats due times via the shared helper, never browser-local`, () => {
      const src = read(rel);
      expect(/toLocaleTimeString|toLocaleDateString|toDateString/.test(src)).toBe(false);
    });
  }
});

describe("LinkedIn 'Message' opens the person (#11)", () => {
  it("OutreachCard never opens a recipient-less compose window", () => {
    const src = read("src/components/queue/OutreachCard.tsx");
    // Only the explanatory comment may mention it — never a window.open target.
    expect(/window\.open\(\s*["'`][^"'`]*messaging\/compose/.test(src)).toBe(false);
  });
});

describe("a logged call outcome completes the touch (#6)", () => {
  const src = read("supabase/functions/outreach-touch-action/index.ts");

  it("set_call_outcome claims the touch and advances the cadence", () => {
    const branch = src.slice(src.indexOf('if (action === "set_call_outcome")'));
    const body = branch.slice(0, branch.indexOf("\n  }\n") + 4);
    expect(body).toContain("claimTouch");
    expect(body).toContain("advanceColdEnrollment");
  });

  it("sits AFTER the replied / inactive / opt-out backstops, like every advancing action", () => {
    // It used to return early above them, which was safe only while it did not
    // advance. Now that it does, an outcome logged on a replied or opted-out
    // lead must be refused by the same guards mark_sent goes through.
    expect(src.indexOf('if (action === "set_call_outcome")'))
      .toBeGreaterThan(src.indexOf("OPT-OUT BACKSTOP"));
  });
});
