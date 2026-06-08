import { describe, expect, it } from "vitest";
import { isValidEmail, isSuspiciousEmail, classifyEmail, summarizeEmailQuality } from "./emailValidation";

describe("isValidEmail", () => {
  it("accepts normal addresses", () => {
    expect(isValidEmail("manu@acme.com")).toBe(true);
    expect(isValidEmail("first.last@sub.example.co.uk")).toBe(true);
  });
  it("rejects malformed addresses", () => {
    for (const bad of ["", "  ", "no-at-sign", "two@@at.com", "a@b", "a@.com", "a@b..com", "spaces in@x.com", "a@b.c m"]) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });
  it("rejects over-long addresses", () => {
    expect(isValidEmail("a".repeat(300) + "@x.com")).toBe(false);
  });
  it("rejects leading/trailing dots in the local part", () => {
    expect(isValidEmail(".alice@acme.com")).toBe(false);
    expect(isValidEmail("alice.@acme.com")).toBe(false);
    expect(isValidEmail("first.last@acme.com")).toBe(true); // interior dots are fine
  });
  it("rejects non-DNS chars and bad labels in the domain", () => {
    for (const bad of ["a@exa_mple.com", "a@foo!.com", "a@foo-.example.com", "a@bar.-example.com"]) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });
});

describe("isSuspiciousEmail", () => {
  it("flags throwaway domains and role/junk local-parts", () => {
    expect(isSuspiciousEmail("jane@example.com")).toBe(true);
    expect(isSuspiciousEmail("test@acme.com")).toBe(true);
    expect(isSuspiciousEmail("noreply@acme.com")).toBe(true);
    expect(isSuspiciousEmail("asdf@acme.com")).toBe(true);
  });
  it("does not flag normal addresses", () => {
    expect(isSuspiciousEmail("manu@acme.com")).toBe(false);
  });
  it("returns false for invalid (handled separately)", () => {
    expect(isSuspiciousEmail("not-an-email")).toBe(false);
  });
});

describe("classifyEmail + summarize", () => {
  it("classifies into the three buckets", () => {
    expect(classifyEmail("manu@acme.com")).toBe("valid");
    expect(classifyEmail("bad")).toBe("invalid");
    expect(classifyEmail("test@example.com")).toBe("suspicious");
  });
  it("summarizes a batch", () => {
    const s = summarizeEmailQuality(["manu@acme.com", "bad", "test@example.com", "x@y.com", null]);
    expect(s.valid).toBe(2);     // manu@, x@y.com
    expect(s.invalid).toBe(2);   // "bad", null
    expect(s.suspicious).toBe(1); // test@example.com
  });
});
