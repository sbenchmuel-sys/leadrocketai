// Regression pins for stripAISignOff (automation-executor pre-signature step).
// Behaviour captured as-is from the inline copy before extraction to
// _shared/signoff.ts — these tests describe what production does today.
import { describe, expect, it } from "vitest";
import { stripAISignOff } from "../../../supabase/functions/_shared/signoff";

describe("stripAISignOff", () => {
  it("removes a trailing 'Best,\\nName' block", () => {
    expect(stripAISignOff("Hi Ana,\n\nQuick note about the demo.\n\nBest,\nMike")).toBe(
      "Hi Ana,\n\nQuick note about the demo.",
    );
  });

  it("handles multi-word sign-offs and trailing whitespace, case-insensitively", () => {
    expect(stripAISignOff("Hi Ana,\n\nSee you Tuesday.\n\nkind regards\nMike Smith  \n")).toBe(
      "Hi Ana,\n\nSee you Tuesday.",
    );
  });

  it("only strips when the sign-off is a paragraph of its own (\\n\\n before it)", () => {
    const body = "Hi Ana,\n\nThanks for your time.\nBest,\nMike";
    expect(stripAISignOff(body)).toBe(body);
  });

  it("leaves a sign-off followed by a long name line (>40 chars) untouched", () => {
    const body = "Hi Ana,\n\nDetails below.\n\nBest,\n" + "M".repeat(41);
    expect(stripAISignOff(body)).toBe(body);
  });

  it("known ceiling: a paragraph starting 'Thanks,' + one short line at the END is treated as a sign-off", () => {
    // Pins current behaviour (the regex only looks at the final paragraph); a
    // real closing sentence under 40 chars after 'Thanks,' is lost today.
    expect(stripAISignOff("Hi Ana,\n\nThanks,\nthe team loved it. Talk soon.")).toBe("Hi Ana,");
  });

  it("trims trailing whitespace even when nothing is stripped", () => {
    expect(stripAISignOff("Hi Ana,\n\nOne line.\n\n")).toBe("Hi Ana,\n\nOne line.");
  });
});
