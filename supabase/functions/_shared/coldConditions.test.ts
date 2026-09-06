// Run: deno test supabase/functions/_shared/coldConditions.test.ts
//
// Pins the cadence-branch rules: which signal each condition reads, that an
// unconditional / unknown step always runs, and the exact reason wording that
// lands on the lead's timeline when a step is skipped for an unmet condition.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { evaluateStepCondition, CONDITION_UNMET_REASON } from "./coldConditions.ts";

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
