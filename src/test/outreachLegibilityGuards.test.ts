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

  it("stamps call_outcome inside the same guarded claim as the status flip (BUG-023)", () => {
    // A double-tap / two open tabs used to run an unconditional `call_outcome`
    // update BEFORE the status-guarded claim, so the loser could overwrite the
    // outcome the winner just recorded even though only the winner's claim
    // succeeded. Fix: call_outcome travels in the claimTouch(...) call itself,
    // so only the request that wins the queued->sent flip ever writes it.
    const branch = src.slice(src.indexOf('if (action === "set_call_outcome")'));
    const body = branch.slice(0, branch.indexOf("\n  }\n") + 4);
    expect(/claimTouch\(\s*"sent"\s*,\s*\{\s*call_outcome:\s*outcome\s*\}\s*\)/.test(body)).toBe(true);
    // No separate unconditional call_outcome write should remain ahead of the claim.
    const claimIdx = body.indexOf("claimTouch(");
    const preClaim = body.slice(0, claimIdx);
    expect(/\.update\(\s*\{\s*call_outcome/.test(preClaim)).toBe(false);
  });
});

describe("campaign cadence status never truncates a lead mid-cadence (#13 paging)", () => {
  // A flat step_number-ordered read capped at a row count could cut a lead off
  // mid-cadence: its cursor would then point past the last row actually fetched,
  // and deriveCadenceStatus would report "completed" for a lead who wasn't.
  // fetchCampaignCadence must page in whole leads instead (order by lead_id first).
  it("orders touch pages by lead_id before step_number, so a lead is never split", () => {
    const src2 = read("src/lib/campaignQueries.ts");
    const fn = src2.slice(src2.indexOf("export async function fetchCampaignCadence"));
    const body = fn.slice(0, fn.indexOf("\nexport ", 1) === -1 ? fn.length : fn.indexOf("\nexport ", 1));
    const leadOrderIdx = body.indexOf('order("lead_id"');
    const stepOrderIdx = body.indexOf('order("step_number"');
    expect(leadOrderIdx).toBeGreaterThan(-1);
    expect(stepOrderIdx).toBeGreaterThan(leadOrderIdx);
  });
});
