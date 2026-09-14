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

// ── Codex review round on PR #136 ──

describe("recording 'they accepted my invite' is never single-homed (P1)", () => {
  // The signal conditional LinkedIn steps branch on (leads.linkedin_connected_at)
  // is rep-entered. It used to live ONLY on the LinkedIn Outreach card, which
  // vanishes the moment that step is completed — acceptance almost always lands
  // after that, so the next LinkedIn touch auto-skipped forever with no way back.
  // It must stay reachable from a surface that outlives the card.
  it("a persistent surface besides the Outreach card can write it", () => {
    const callers = [
      "src/components/queue/OutreachCard.tsx",
      "src/components/queue/UpcomingTouchesStrip.tsx",
    ].filter((rel) => /setLinkedinAccepted\s*\(/.test(read(rel)));
    expect(callers).toContain("src/components/queue/UpcomingTouchesStrip.tsx");
    expect(callers.length).toBeGreaterThan(1);
  });

  it("the strip carries the lead's current accepted state, so the toggle isn't blind", () => {
    expect(read("src/lib/upcomingTouchesQueries.ts")).toMatch(/linkedin_connected_at/);
  });
});

describe("a conditional step reads as conditional outside edit mode (P2)", () => {
  // CampaignScript renders the branch badge from step.condition. The read-only
  // projection on the campaign page used to drop the field, so "only if they
  // accepted the invite" silently rendered as an unconditional touch.
  it("CampaignDetail's read-only projection passes condition through", () => {
    const src = read("src/pages/CampaignDetail.tsx");
    const readOnly = src.slice(src.lastIndexOf("<CampaignScript"));
    expect(readOnly).toMatch(/condition:\s*s\.condition/);
  });
});

describe("an immediately-due LinkedIn touch is not exposed mid-enrichment (P2)", () => {
  // The pure deferral is unit-tested in campaignEnrollment.test.ts. What a unit
  // test can't see is whether enrollLeadsInCampaign still APPLIES it, and applies
  // it to the plan BEFORE the enrollment RPC commits the touches — afterwards
  // would leave a window for the 5-minute scheduler to auto-skip the step for
  // good.
  it("the deferral is applied to the plan before enroll_campaign_leads is called", () => {
    const src = read("src/lib/campaignEnrollment.ts");
    const deferAt = src.indexOf("deferLinkedinTouchesPendingLookup(\n");
    const rpcAt = src.indexOf('rpc("enroll_campaign_leads"');
    expect(deferAt).toBeGreaterThan(-1);
    expect(rpcAt).toBeGreaterThan(-1);
    expect(deferAt).toBeLessThan(rpcAt);
  });
});

describe("concurrent enrollment of one lead can't abort the batch (P2)", () => {
  // Two calls racing on the same lead used to both pass the already-enrolled
  // check; the loser's insert tripped a unique constraint and rolled back every
  // unrelated lead in its batch. The lead rows must be locked BEFORE that check.
  // Behaviour is covered by supabase/tests/enrollment_rpcs.test.sql (CI).
  it("the enrollment RPC locks the payload's leads before checking for an enrollment", () => {
    const sql = read("supabase/migrations/20260907000000_transactional_enrollment_rpcs.sql");
    const fn = sql.slice(sql.indexOf("FUNCTION public.enroll_campaign_leads"), sql.indexOf("FUNCTION public.launch_campaign_with_schedule"));
    const lockAt = fn.indexOf("FOR UPDATE");
    const checkAt = fn.indexOf("campaign_id = _campaign_id AND e.lead_id = v_lead_id");
    expect(lockAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(checkAt);
    // Deterministic lock order, or two overlapping batches deadlock instead.
    expect(fn).toMatch(/ORDER BY id\s*\n\s*FOR UPDATE/);
  });
});
