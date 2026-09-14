// Run: deno test supabase/functions/_shared/coldConditions.test.ts
//
// Pins the cadence-branch rules: which signal each condition reads, that an
// unconditional / unknown step always runs, and the exact reason wording that
// lands on the lead's timeline when a step is skipped for an unmet condition.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { evaluateStepCondition, stepConditionUnmetReason, CONDITION_UNMET_REASON } from "./coldConditions.ts";

const none = { linkedinAccepted: false, callAnswered: false };
const both = { linkedinAccepted: true, callAnswered: true };

Deno.test("no condition (or an unknown one) always runs", () => {
  assertEquals(evaluateStepCondition(null, none), null);
  assertEquals(evaluateStepCondition(undefined, none), null);
  assertEquals(evaluateStepCondition("", none), null);
  assertEquals(evaluateStepCondition("moon_is_full", none), null);
});

Deno.test("linkedin_accepted reads the rep-marked signal", () => {
  assertEquals(evaluateStepCondition("linkedin_accepted", none), CONDITION_UNMET_REASON.linkedin_accepted);
  assertEquals(evaluateStepCondition("linkedin_accepted", { ...none, linkedinAccepted: true }), null);
});

Deno.test("call_answered / no_call_answered are exact opposites on the call signal", () => {
  assertEquals(evaluateStepCondition("call_answered", none), CONDITION_UNMET_REASON.call_answered);
  assertEquals(evaluateStepCondition("call_answered", both), null);
  assertEquals(evaluateStepCondition("no_call_answered", none), null);
  assertEquals(evaluateStepCondition("no_call_answered", both), CONDITION_UNMET_REASON.no_call_answered);
});

// A tiny chainable stub: every table read resolves to the canned result.
function fakeClient(results: Record<string, { data: unknown; error: { message: string } | null }>) {
  const chain = (table: string) => {
    const res = results[table] ?? { data: null, error: null };
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "limit"]) q[m] = () => q;
    q.maybeSingle = () => Promise.resolve(res);
    q.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(res).then(ok, ko);
    return q;
  };
  return { from: chain };
}

Deno.test("stepConditionUnmetReason fails CLOSED when a read errors (Codex P1 on PR #136)", async () => {
  const touch = { campaign_id: "c", step_number: 2, enrollment_id: "e", lead_id: "l" };
  // Step read errors → throw, never "unconditional".
  let threw = false;
  try {
    await stepConditionUnmetReason(fakeClient({ campaign_steps: { data: null, error: { message: "boom" } } }), touch);
  } catch { threw = true; }
  assertEquals(threw, true);
  // Signal read errors → throw too.
  threw = false;
  try {
    await stepConditionUnmetReason(fakeClient({
      campaign_steps: { data: { condition: "call_answered" }, error: null },
      leads: { data: { linkedin_connected_at: null }, error: null },
      campaign_touch: { data: null, error: { message: "boom" } },
    }), touch);
  } catch { threw = true; }
  assertEquals(threw, true);
  // Healthy reads still evaluate.
  const unmet = await stepConditionUnmetReason(fakeClient({
    campaign_steps: { data: { condition: "call_answered" }, error: null },
    leads: { data: { linkedin_connected_at: null }, error: null },
    campaign_touch: { data: [], error: null },
  }), touch);
  assertEquals(unmet, CONDITION_UNMET_REASON.call_answered);
  assertEquals(await stepConditionUnmetReason(fakeClient({ campaign_steps: { data: { condition: null }, error: null } }), touch), null);
});
