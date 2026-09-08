// Regression pins for the ai_task reasoning-leak strippers. Behaviour captured
// as-is before extraction to _shared/draftPostprocess.ts; these describe what
// production does today, not what it should ideally do.
import { describe, expect, it } from "vitest";
import {
  stripLeakedReasoning,
  stripLeakedReasoningForTask,
  stripValidationNoiseLines,
  stripSelfChecksAndDuplicateBodies,
} from "../../../supabase/functions/_shared/draftPostprocess";

const EMAIL = "Hi Ana,\n\nSaw your team is scaling SDRs — happy to share what worked for two similar teams.\n\nBest,\nMike";

describe("stripLeakedReasoning", () => {
  it("returns clean email text unchanged (modulo trim)", () => {
    expect(stripLeakedReasoning(EMAIL + "\n")).toBe(EMAIL);
  });

  it("drops an INTERNAL REASONING block that precedes the email", () => {
    const leaked = "INTERNAL REASONING (do not show)\nThe lead is a VP. I should be brief.\n\n" + EMAIL;
    expect(stripLeakedReasoning(leaked)).toBe(EMAIL);
  });

  it("returns '' when a reasoning header has no salvageable email after it", () => {
    expect(stripLeakedReasoning("INTERNAL ANALYSIS\nnothing useful here\nstill nothing")).toBe("");
  });

  it("strips self-check lines and keeps the last complete email when the model wrote two", () => {
    const first = "Hi Ana,\n\nFirst attempt that is long enough to count as a real email body.\n\nBest,\nMike";
    const text = first + "\n\nWord count check: 38 words. All instructions followed.\n\n" + EMAIL;
    expect(stripLeakedReasoning(text)).toBe(EMAIL);
  });

  it("removes stray 'Plan:' / 'Notes:' lines from an otherwise clean email", () => {
    expect(stripLeakedReasoning("Notes: keep it short\n" + EMAIL)).toBe(EMAIL);
  });

  it("passes empty input through", () => {
    expect(stripLeakedReasoning("")).toBe("");
  });
});

describe("stripValidationNoiseLines / stripSelfChecksAndDuplicateBodies", () => {
  it("filters bullet-prefixed self-check lines and collapses blank runs", () => {
    expect(stripValidationNoiseLines("Hi Ana,\n\n- Constraint check: ok\n\n\n\nBody line.")).toBe(
      "Hi Ana,\n\nBody line.",
    );
  });

  it("keeps the body before a self-check marker when nothing follows it", () => {
    expect(stripSelfChecksAndDuplicateBodies(EMAIL + "\n\nFinal check: done")).toBe(EMAIL);
  });
});

describe("stripLeakedReasoningForTask", () => {
  it("delegates to stripLeakedReasoning for email tasks", () => {
    expect(stripLeakedReasoningForTask(EMAIL, "pre_email_1_intro")).toBe(EMAIL);
  });

  it("salvages a subject line after a leaked reasoning header for cold_email_subject", () => {
    const text = "INTERNAL REASONING\nshort and specific\n\nFINAL OUTPUT:\nSubject: Quick idea for Acme's SDR ramp";
    expect(stripLeakedReasoningForTask(text, "cold_email_subject")).toBe("Quick idea for Acme's SDR ramp");
  });

  it("salvages the last bullets for cold_call_talking_points", () => {
    const text = "CHAIN OF THOUGHT\nthink think\n\nTALKING POINTS:\n- Open with the hiring signal\n- Ask about ramp time\n- Offer the 2-team benchmark";
    expect(stripLeakedReasoningForTask(text, "cold_call_talking_points")).toBe(
      "- Open with the hiring signal\n- Ask about ramp time\n- Offer the 2-team benchmark",
    );
  });

  it("salvages the visible tail when the email stripper returns '' but a leak marker is present", () => {
    // Pins current behaviour: the task-aware fallback keeps whatever non-reasoning
    // lines remain rather than returning '' (the caller would 502 on '').
    expect(stripLeakedReasoningForTask("INTERNAL REFLECTION\nzzz", "pre_email_1_intro")).toBe("zzz");
  });
});
