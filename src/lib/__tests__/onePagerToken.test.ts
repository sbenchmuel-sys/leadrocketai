import { describe, expect, it } from "vitest";
import {
  ONE_PAGER_LINK_TOKEN,
  applyOnePagerToken,
} from "../../../supabase/functions/_shared/onePagerToken";

// The send-time gate for the uploaded one-pager. The load-bearing guarantee: a
// removed/never-ready one-pager must NEVER leave a dead link or a dangling
// "P.S. …" fragment in a prospect's inbox.

const BODY_WITH_OFFER =
  `Hi {FirstName},\n\nQuick follow-up with a fresh angle.\n\nBest,\n{RepFirstName}` +
  `\n\nP.S. I put together a short one-pager that might be useful — here it is: ${ONE_PAGER_LINK_TOKEN}`;

describe("applyOnePagerToken", () => {
  it("replaces the token with the public link when a ready one-pager exists", () => {
    const out = applyOnePagerToken(BODY_WITH_OFFER, "https://x.supabase.co/storage/v1/object/public/c/p.pdf");
    expect(out).toContain("here it is: https://x.supabase.co/storage/v1/object/public/c/p.pdf");
    expect(out).not.toContain(ONE_PAGER_LINK_TOKEN);
  });

  it("strips the entire offer line when no ready one-pager exists (no dead link, no fragment)", () => {
    const out = applyOnePagerToken(BODY_WITH_OFFER, null);
    expect(out).not.toContain(ONE_PAGER_LINK_TOKEN);
    expect(out).not.toContain("P.S."); // the whole offer line is gone
    expect(out).not.toContain("here it is");
    expect(out.endsWith("{RepFirstName}")).toBe(true); // clean tail, no trailing blank lines
  });

  it("treats a blank url as 'not ready' and strips the offer", () => {
    expect(applyOnePagerToken(BODY_WITH_OFFER, "   ")).not.toContain("P.S.");
  });

  it("leaves a body with no token untouched", () => {
    const plain = "Hi {FirstName},\n\nNo attachment here.\n\nBest,\n{RepFirstName}";
    expect(applyOnePagerToken(plain, "https://x/p.pdf")).toBe(plain);
    expect(applyOnePagerToken(plain, null)).toBe(plain);
  });

  it("replaces every occurrence if the token somehow appears more than once", () => {
    const dbl = `a ${ONE_PAGER_LINK_TOKEN} b ${ONE_PAGER_LINK_TOKEN}`;
    expect(applyOnePagerToken(dbl, "URL")).toBe("a URL b URL");
  });
});
