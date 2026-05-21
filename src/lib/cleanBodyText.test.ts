import { describe, it, expect } from "vitest";
import { cleanBodyText } from "./cleanBodyText";

describe("cleanBodyText", () => {
  it("prefers ai_summary over snippet_text when both present", () => {
    const out = cleanBodyText({
      ai_summary: "Asks about Q3 pricing tiers and a 2-week pilot.",
      snippet_text: "Hi Sam,\n\nQuick one — what does Q3 pricing look like?",
    });
    expect(out).toBe("Asks about Q3 pricing tiers and a 2-week pilot.");
  });

  it("falls back to snippet_text when ai_summary is null", () => {
    const out = cleanBodyText({
      ai_summary: null,
      snippet_text: "Hi Sam — thanks for the proposal, looks good.",
    });
    expect(out).toBe("Hi Sam — thanks for the proposal, looks good.");
  });

  it("falls back when ai_summary is empty/whitespace-only", () => {
    const out = cleanBodyText({
      ai_summary: "   ",
      snippet_text: "Quick reply.",
    });
    expect(out).toBe("Quick reply.");
  });

  it("strips Gmail-style quoted reply block", () => {
    const raw = [
      "Sounds good — happy to set up a call next week.",
      "",
      "On Tue, May 19, 2026 at 9:14 AM, Sam <s@x.com> wrote:",
      "> Hi Manu, I wanted to circle back on the pricing question.",
      "> Specifically the Q3 tiers and a 2-week pilot for the team.",
    ].join("\n");
    const out = cleanBodyText({ snippet_text: raw });
    expect(out).toBe("Sounds good — happy to set up a call next week.");
  });

  it("strips Outlook-style From: quote header", () => {
    const raw = [
      "Yes, Thursday works. Send a calendar invite.",
      "",
      "From: Sam Bench <sam@drivepilot.io>",
      "Sent: Tuesday, May 19, 2026 9:14 AM",
      "To: Manu Rajendra",
      "Subject: Re: Pricing question",
      "",
      "Hi Manu, can we revisit the pricing tiers?",
    ].join("\n");
    const out = cleanBodyText({ snippet_text: raw });
    expect(out).toBe("Yes, Thursday works. Send a calendar invite.");
  });

  it("strips RFC-3676 signature block after dash-dash line", () => {
    const raw = [
      "Confirmed for Thursday.",
      "",
      "-- ",
      "Manu Rajendra | VP Sales | Acme Corp",
      "+1 555 0100",
    ].join("\n");
    const out = cleanBodyText({ snippet_text: raw });
    expect(out).toBe("Confirmed for Thursday.");
  });

  it("strips em-dash signature variant", () => {
    const raw = ["Sure, sending now.", "", "——", "Manu"].join("\n");
    const out = cleanBodyText({ snippet_text: raw });
    expect(out).toBe("Sure, sending now.");
  });

  it("strips long-underscore Outlook separator", () => {
    const raw = [
      "Approved — go ahead.",
      "",
      "________________________________",
      "From: Sam Bench",
      "Quoted history follows…",
    ].join("\n");
    const out = cleanBodyText({ snippet_text: raw });
    expect(out).toBe("Approved — go ahead.");
  });

  it("clamps to 2 lines max and joins with space", () => {
    const raw = [
      "Line one.",
      "Line two.",
      "Line three should be dropped.",
      "And line four.",
    ].join("\n");
    const out = cleanBodyText({ snippet_text: raw });
    expect(out).toBe("Line one. Line two.");
  });

  it("joins separate content paragraphs with a single space", () => {
    const raw = "Hi there.\n\n\n\nLet me know what works.";
    const out = cleanBodyText({ snippet_text: raw });
    expect(out).toBe("Hi there. Let me know what works.");
  });

  it("trims trailing whitespace on each line", () => {
    const raw = "Hi there.   \nLet me know.   ";
    const out = cleanBodyText({ snippet_text: raw });
    expect(out).toBe("Hi there. Let me know.");
  });

  it("returns empty string when both fields are null", () => {
    const out = cleanBodyText({ ai_summary: null, snippet_text: null });
    expect(out).toBe("");
  });

  it("returns empty string when both fields are missing", () => {
    const out = cleanBodyText({});
    expect(out).toBe("");
  });

  it("truncates with ellipsis when one line exceeds 220 chars", () => {
    const long = "a".repeat(300);
    const out = cleanBodyText({ snippet_text: long });
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(220);
  });

  it("handles CRLF line endings (Outlook MIME default)", () => {
    const raw = "Hi there.\r\n\r\nQuick question on pricing.";
    const out = cleanBodyText({ snippet_text: raw });
    expect(out).toBe("Hi there. Quick question on pricing.");
  });

  it("does not strip a stray 'On…' that isn't a quote header", () => {
    const out = cleanBodyText({
      snippet_text: "On Thursday we land the migration. Let me know if blocked.",
    });
    expect(out).toBe("On Thursday we land the migration. Let me know if blocked.");
  });

  it("returns empty string when snippet is only a signature block", () => {
    const raw = "-- \nSam\nFounder, Acme";
    const out = cleanBodyText({ snippet_text: raw });
    expect(out).toBe("");
  });
});
