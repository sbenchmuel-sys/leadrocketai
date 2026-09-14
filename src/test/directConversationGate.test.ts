// BEHAVIOURAL tests for the rep↔lead gate (Unit G-B, finding 4).
//
// These call the real exported function and assert on its RETURN VALUE — no
// source-text scanning, no stubs. Mirrored by the Deno suite at
// supabase/functions/_shared/directConversation.test.ts.
//
// Regression under test: gmail-bulk-sync had no direct-conversation gate at
// all. Any third-party message that merely mentioned the lead's address was
// stored against the lead.
import { describe, expect, it } from "vitest";
import { isDirectConversation } from "../../supabase/functions/_shared/directConversation.ts";

const LEAD = "manu@acme.com";
const REP = "rep@drivepilot.io";

describe("isDirectConversation", () => {
  it("keeps lead → rep", () => {
    expect(isDirectConversation({
      fromEmails: [LEAD], recipientEmails: [REP], leadEmail: LEAD, repEmail: REP,
    })).toBe(true);
  });

  it("keeps rep → lead", () => {
    expect(isDirectConversation({
      fromEmails: [REP], recipientEmails: [LEAD, "cfo@acme.com"], leadEmail: LEAD, repEmail: REP,
    })).toBe(true);
  });

  it("DROPS third-party mail addressed to the lead (newsletter)", () => {
    expect(isDirectConversation({
      fromEmails: ["news@substack.com"], recipientEmails: [LEAD], leadEmail: LEAD, repEmail: REP,
    })).toBe(false);
  });

  it("DROPS mail from the lead to someone who is not the rep", () => {
    expect(isDirectConversation({
      fromEmails: [LEAD], recipientEmails: ["someone-else@acme.com"], leadEmail: LEAD, repEmail: REP,
    })).toBe(false);
  });

  it("DROPS a third-party thread that merely mentions both addresses in From", () => {
    // The old bulk-sync check (`messageInvolvesLead`) returned true here.
    expect(isDirectConversation({
      fromEmails: ["noreply@tool.com"], recipientEmails: ["ops@acme.com"], leadEmail: LEAD, repEmail: REP,
    })).toBe(false);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isDirectConversation({
      fromEmails: ["  MANU@Acme.COM "], recipientEmails: [" Rep@DrivePilot.io"], leadEmail: LEAD, repEmail: REP,
    })).toBe(true);
  });

  it("fails CLOSED when the rep mailbox address is unknown", () => {
    expect(isDirectConversation({
      fromEmails: [LEAD], recipientEmails: [REP], leadEmail: LEAD, repEmail: "",
    })).toBe(false);
  });

  it("fails CLOSED when the lead address is unknown", () => {
    expect(isDirectConversation({
      fromEmails: [LEAD], recipientEmails: [REP], leadEmail: "   ", repEmail: REP,
    })).toBe(false);
  });

  it("does not match a substring of a longer address", () => {
    // "ann@acme.com" must not match inside "joann@acme.com".
    expect(isDirectConversation({
      fromEmails: ["joann@acme.com"], recipientEmails: [REP], leadEmail: "ann@acme.com", repEmail: REP,
    })).toBe(false);
  });
});
