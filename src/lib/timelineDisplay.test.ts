import { describe, it, expect } from "vitest";
import { stripEmailDisclaimer, relativeTimeShort, oneLineGist } from "@/lib/timelineDisplay";

describe("stripEmailDisclaimer", () => {
  it("cuts a trailing confidentiality notice", () => {
    const body =
      "Sounds good, let's lock Tuesday at 2pm.\n\nCONFIDENTIALITY NOTICE: This email and any attachments are confidential and may be legally privileged.";
    expect(stripEmailDisclaimer(body)).toBe("Sounds good, let's lock Tuesday at 2pm.");
  });

  it("cuts an 'if you are not the intended recipient' footer", () => {
    const body =
      "Thanks — approved on our end.\n--\nIf you are not the intended recipient, please delete this message.";
    expect(stripEmailDisclaimer(body)).toBe("Thanks — approved on our end.");
  });

  it("leaves a clean message untouched", () => {
    const body = "Can you send the revised quote by Friday?";
    expect(stripEmailDisclaimer(body)).toBe(body);
  });

  it("does not blank a message that is only a disclaimer", () => {
    const body = "CONFIDENTIALITY NOTICE: This message is confidential.";
    expect(stripEmailDisclaimer(body)).toBe(body);
  });

  it("handles empty/nullish input", () => {
    expect(stripEmailDisclaimer("")).toBe("");
    expect(stripEmailDisclaimer(null)).toBe("");
    expect(stripEmailDisclaimer(undefined)).toBe("");
  });
});

describe("relativeTimeShort", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  it("formats recent times compactly", () => {
    expect(relativeTimeShort(ago(10 * 1000))).toBe("just now");
    expect(relativeTimeShort(ago(5 * 60 * 1000))).toBe("5m ago");
    expect(relativeTimeShort(ago(2 * 60 * 60 * 1000))).toBe("2h ago");
    expect(relativeTimeShort(ago(3 * 24 * 60 * 60 * 1000))).toBe("3d ago");
    expect(relativeTimeShort(ago(14 * 24 * 60 * 60 * 1000))).toBe("2w ago");
  });
  it("falls back to a date for old or future timestamps", () => {
    expect(relativeTimeShort(ago(90 * 24 * 60 * 60 * 1000))).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(relativeTimeShort(future)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });
  it("returns empty for an invalid date", () => {
    expect(relativeTimeShort("not-a-date")).toBe("");
  });
});

describe("oneLineGist", () => {
  it("skips a short greeting line", () => {
    expect(oneLineGist("Hi Kenneth,\n\nThe revised proposal is attached.")).toBe(
      "The revised proposal is attached.",
    );
  });
  it("keeps a single substantive line", () => {
    expect(oneLineGist("Can we move to Thursday?")).toBe("Can we move to Thursday?");
  });
  it("keeps a greeting line that also carries the ask (Codex P2)", () => {
    expect(oneLineGist("Hi Ken, can we meet today?\nThanks")).toBe("Hi Ken, can we meet today?");
  });
  it("still skips a greeting-only line with a longer name", () => {
    expect(oneLineGist("Dear Sir or Madam,\nPlease find the invoice attached.")).toBe(
      "Please find the invoice attached.",
    );
  });
  it("does not over-skip when there is only a greeting", () => {
    expect(oneLineGist("Hi Kenneth,")).toBe("Hi Kenneth,");
  });
  it("handles empty input", () => {
    expect(oneLineGist("")).toBe("");
    expect(oneLineGist(null)).toBe("");
  });
});
