import { describe, it, expect } from "vitest";
// Pure leaf — zero server-only imports, so it loads under vitest.
import {
  isSendableColdEmail,
  isColdSuppressed,
} from "../../../supabase/functions/_shared/coldSendFloorRules";

// These guard two pieces of the fail-closed cold-send floor: a cold email is only
// sendable to a syntactically valid address, and a lead on the workspace
// do-not-contact list (by exact email OR domain) is never sent. A regression here
// would let a suppressed or malformed-address lead get a real email.
describe("isSendableColdEmail — fail-closed email backstop", () => {
  it("accepts ordinary valid addresses", () => {
    expect(isSendableColdEmail("a@b.com")).toBe(true);
    expect(isSendableColdEmail("first.last@sub.example.co.uk")).toBe(true);
    expect(isSendableColdEmail("  trimmed@example.com  ")).toBe(true); // trims
  });

  it("rejects empty / missing / whitespace", () => {
    expect(isSendableColdEmail("")).toBe(false);
    expect(isSendableColdEmail("   ")).toBe(false);
    expect(isSendableColdEmail(undefined as unknown as string)).toBe(false);
  });

  it("rejects structurally broken addresses", () => {
    expect(isSendableColdEmail("no-at-sign")).toBe(false);
    expect(isSendableColdEmail("a@b")).toBe(false); // no TLD dot
    expect(isSendableColdEmail("a b@c.com")).toBe(false); // space
    expect(isSendableColdEmail("a@@b.com")).toBe(false);
    expect(isSendableColdEmail("a@localhost")).toBe(false); // single-label domain
  });

  it("rejects consecutive dots and dot-bounded local parts", () => {
    expect(isSendableColdEmail("a..b@c.com")).toBe(false);
    expect(isSendableColdEmail(".a@c.com")).toBe(false);
    expect(isSendableColdEmail("a.@c.com")).toBe(false);
  });

  it("rejects invalid DNS labels (hyphen-bounded, underscore, empty)", () => {
    expect(isSendableColdEmail("a@-example.com")).toBe(false);
    expect(isSendableColdEmail("a@example-.com")).toBe(false);
    expect(isSendableColdEmail("a@exa_mple.com")).toBe(false);
    expect(isSendableColdEmail("a@foo-.bar.com")).toBe(false); // bad intermediate label
  });

  it("rejects over-length local part and whole address", () => {
    expect(isSendableColdEmail("a".repeat(65) + "@b.com")).toBe(false); // local > 64
    const huge = "a".repeat(250) + "@" + "b".repeat(60) + ".com"; // > 254 total
    expect(isSendableColdEmail(huge)).toBe(false);
  });
});

describe("isColdSuppressed — exact email AND domain matching", () => {
  const email = "lead@acme.com";
  const domain = "acme.com";

  it("suppresses on an exact email-kind match", () => {
    expect(isColdSuppressed(email, domain, [{ kind: "email", value: "lead@acme.com" }])).toBe(true);
  });

  it("suppresses on an exact domain-kind match", () => {
    expect(isColdSuppressed(email, domain, [{ kind: "domain", value: "acme.com" }])).toBe(true);
  });

  it("does NOT suppress when kind and value are mismatched", () => {
    // email-kind row holding a bare domain must not block the whole domain…
    expect(isColdSuppressed(email, domain, [{ kind: "email", value: "acme.com" }])).toBe(false);
    // …and a domain-kind row holding a full email must not match the email.
    expect(isColdSuppressed(email, domain, [{ kind: "domain", value: "lead@acme.com" }])).toBe(false);
  });

  it("does NOT suppress an unrelated address", () => {
    expect(isColdSuppressed(email, domain, [{ kind: "email", value: "someone@other.com" }])).toBe(false);
    expect(isColdSuppressed(email, domain, [{ kind: "domain", value: "other.com" }])).toBe(false);
  });

  it("returns false on an empty / missing list", () => {
    expect(isColdSuppressed(email, domain, [])).toBe(false);
    expect(isColdSuppressed(email, domain, undefined as unknown as [])).toBe(false);
  });

  it("matches when any one of several rows hits", () => {
    const rows = [
      { kind: "email", value: "x@y.com" },
      { kind: "domain", value: "acme.com" },
    ];
    expect(isColdSuppressed(email, domain, rows)).toBe(true);
  });
});
