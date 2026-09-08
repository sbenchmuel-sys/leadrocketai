// Parity guard: src/lib/draftValidator.ts is a hand-maintained mirror of
// supabase/functions/_shared/draftValidator.ts (allowlisted collision in
// src/test/noDuplicateBasenames.test.ts). Until the src copy is replaced by an
// @shared import, both must return identical results on the same input.
import { describe, expect, it } from "vitest";
import * as client from "../draftValidator";
import * as shared from "../../../supabase/functions/_shared/draftValidator";

const LINK = "https://cal.example/mike";

const FIXTURES: Array<{ name: string; body: string; ctx: shared.ValidationContext }> = [
  {
    name: "clean cold intro",
    body: "Hi Ana,\n\nSaw your team is hiring SDRs — two similar teams cut ramp time by a third with one change. Worth a look?\n\nBest,\nMike",
    ctx: { kind: "cold_intro", lead_first_name: "Ana" },
  },
  {
    name: "unresolved placeholder",
    body: "Hi [First Name],\n\nQuick idea on your SDR ramp that helped two similar teams.\n\nBest,\nMike",
    ctx: { kind: "cold_intro", lead_first_name: "Ana" },
  },
  {
    name: "leaked reasoning + no sign-off",
    body: "INTERNAL REASONING: be brief\nHi Ana,\n\nQuick idea on your SDR ramp that helped two similar teams.",
    ctx: { kind: "cold_followup", lead_first_name: "Ana" },
  },
  {
    name: "inbound missing meeting link and CTA",
    body: "Hi Ana,\n\nThanks for reaching out — great to hear the pilot went well and the team liked it.\n\nBest,\nMike",
    ctx: { kind: "inbound_intro", lead_first_name: "Ana", meeting_link: LINK },
  },
  {
    name: "breakup without close-loop",
    body: "Hi Ana,\n\nI'll stop here. It was a pleasure learning about your team and the plans for next quarter.\n\nBest,\nMike",
    ctx: { kind: "cold_breakup", lead_first_name: "Ana" },
  },
  {
    name: "German draft (Hallo/Viele Grüße — outside the English greeting/sign-off vocab)",
    body: "Hallo Herr Müller,\n\nvielen Dank für das Gespräch gestern. Ich schicke Ihnen wie besprochen die Unterlagen zum Pilotprojekt.\n\nViele Grüße\nMike",
    ctx: { kind: "reply", lead_first_name: "Jonas" },
  },
];

describe("draftValidator parity (src/lib mirror vs _shared canonical)", () => {
  for (const f of FIXTURES) {
    it(`validateDraft agrees on: ${f.name}`, () => {
      expect(client.validateDraft(f.body, f.ctx as client.ValidationContext)).toEqual(shared.validateDraft(f.body, f.ctx));
    });
  }

  it("kindFromTask agrees on every known task name and an unknown one", () => {
    for (const task of [
      "pre_email_1_intro", "pre_email_2_followup", "pre_email_4_breakup", "inbound_intro",
      "inbound_followup_2", "nurture_email_single", "reply_to_thread", "post_meeting_followup_email", "totally_unknown",
    ]) {
      expect(client.kindFromTask(task)).toBe(shared.kindFromTask(task));
    }
  });
});
