// ============================================================================
// GOLDEN / SNAPSHOT TESTS — campaign resolver (client + server)
//
// PURPOSE (Unit B, 4→9 cadence change): prove the legacy 4-step action keys
// (send_pre_1..4, nurture_1..4) resolve BYTE-IDENTICAL before vs after the
// resolver change. The resolver feeds the LIVE send path (automation-executor)
// + the manual-draft path (generateDraft.ts), so "unchanged" must be proven.
//
// HOW THIS IS A REAL GATE
// -----------------------
// The expected blocks below are NOT produced by the code under test. They are
// reconstructed from a small, independent formatter (`buildBlock`) + per-case
// field tables. So:
//   • Run on current `main` (resolver unchanged)  → MUST be green = the tables
//     correctly capture today's behavior (the true baseline).
//   • Run on this branch (resolver widened 4→9)    → MUST stay green = the 4-step
//     legacy output is byte-identical.
// If either run is red, the change is NOT byte-identical — do not merge.
//
// NOTE on a pre-existing cross-resolver divergence (documented, not introduced
// here): client `nurture_4` framework = "neutral_observation" while server
// `nurture_4` = "breakup". Each resolver is therefore checked against its OWN
// baseline, never against the other. This is the known "two resolvers can drift"
// hazard (CLAUDE.md) — captured here so any future convergence is deliberate.
// ============================================================================

import { describe, it, expect } from "vitest";

// Client resolver (manual-draft path)
import { buildCampaignPayloadFields } from "@/lib/campaignResolver";

// Server resolver (automation-executor path) — esm.sh-free after the
// campaignStepConfig.ts extraction, so importable directly by vitest.
import {
  resolveCampaignInstruction,
  formatInstructionForPrompt,
} from "../../../supabase/functions/_shared/campaignResolver";

// ── Shared expected field tables ────────────────────────────────────────────

const EMAIL_RULES: Record<number, string[]> = {
  1: [
    "2 short paragraphs max",
    "First sentence proves you know who they are",
    "Last sentence is a question (CTA)",
    "No feature lists, no attachments, no calendar links unless instructed",
  ],
  2: [
    "Do NOT start with 'Just following up' / 'Checking in'",
    "Reference previous email briefly, then pivot to NEW angle",
    "One question only",
  ],
  3: [
    "Lead with one concrete insight or result",
    "The insight must relate to THEIR industry",
    "Different angle than previous emails",
  ],
  4: [
    "No guilt, no fake urgency",
    "Ask a direct yes/no question",
    "Leave the door open in one sentence",
  ],
};

const EMAIL_HINTS: Record<number, string[]> = {
  1: ["Prove you know who they are in the first sentence"],
  2: ["Reference previous email briefly, then pivot to a NEW angle"],
  3: ["Lead with proof or a concrete result"],
  4: ["No guilt, no urgency — direct yes/no question"],
};

const EMAIL_WORDS: Record<number, number> = { 1: 75, 2: 60, 3: 60, 4: 40 };
const EMAIL_CTA: Record<number, string> = {
  1: "question",
  2: "question",
  3: "soft_offer",
  4: "breakup_close",
};

const OUTBOUND_OBJECTIVES: Record<number, string> = {
  1: "Get a reply by being specific and human",
  2: "Give them a new reason to reply — different angle",
  3: "Share proof or value — make it easy to say yes",
  4: "Close the loop respectfully — get a yes or no",
};

const NURTURE_OBJECTIVES: Record<number, string> = {
  1: "Share a relevant industry insight — build credibility, no pitch",
  2: "Provide a case study or proof point — show tangible results",
  3: "Offer a value-add resource — be genuinely helpful",
  4: "Re-engage with a fresh angle — soft check-in",
};

const OUTBOUND_FRAMEWORK: Record<number, string> = {
  1: "neutral_observation",
  2: "hypothesis",
  3: "value_add",
  4: "breakup",
};

// Client nurture framework (per the client resolver).
const CLIENT_NURTURE_FRAMEWORK: Record<number, string> = {
  1: "value_add",
  2: "value_add",
  3: "value_add",
  4: "neutral_observation",
};

// Server nurture framework (step 3/4 ordering differs — see header note).
const SERVER_NURTURE_FRAMEWORK: Record<number, string> = {
  1: "value_add",
  2: "value_add",
  3: "value_add",
  4: "breakup",
};

// ── Independent block formatter (mirrors both resolvers' no-context output) ──

function buildBlock(f: {
  channel: string;
  framework: string;
  objective: string;
  step: number;
  total: number;
  words: number;
  cta: string;
  rules: string[];
  hints: string[];
}): string {
  const lines: string[] = [
    "=== CAMPAIGN INSTRUCTION (STRUCTURED) ===",
    `Channel: ${f.channel}`,
    `Framework: ${f.framework}`,
    `Objective: ${f.objective}`,
    `Sequence: Step ${f.step} of ${f.total}`,
    `Max words: ${f.words}`,
    `CTA type: ${f.cta}`,
  ];
  if (f.rules.length > 0) {
    lines.push("\nHARD RULES (mandatory):");
    for (const r of f.rules) lines.push(`- ${r}`);
  }
  if (f.hints.length > 0) {
    lines.push("\nGENERATION HINTS:");
    for (const h of f.hints) lines.push(`- ${h}`);
  }
  lines.push("=== END CAMPAIGN INSTRUCTION ===");
  return lines.join("\n");
}

// ── Client resolver (buildCampaignPayloadFields) ────────────────────────────

describe("CLIENT resolver — legacy outbound (send_pre_1..4) byte-identical", () => {
  for (const step of [1, 2, 3, 4]) {
    it(`send_pre_${step}`, () => {
      const out = buildCampaignPayloadFields({
        action_key: `send_pre_${step}`,
        motion: "outbound_prospecting",
      }).campaign_instruction;

      const expected = buildBlock({
        channel: "email",
        framework: OUTBOUND_FRAMEWORK[step],
        objective: OUTBOUND_OBJECTIVES[step],
        step,
        total: 4,
        words: EMAIL_WORDS[step],
        cta: EMAIL_CTA[step],
        rules: EMAIL_RULES[step],
        hints: EMAIL_HINTS[step],
      });
      expect(out).toBe(expected);
    });
  }
});

describe("CLIENT resolver — legacy nurture (nurture_1..4) byte-identical", () => {
  for (const step of [1, 2, 3, 4]) {
    it(`nurture_${step}`, () => {
      const out = buildCampaignPayloadFields({
        action_key: `nurture_${step}`,
        motion: "nurture",
      }).campaign_instruction;

      const expected = buildBlock({
        channel: "email",
        framework: CLIENT_NURTURE_FRAMEWORK[step],
        objective: NURTURE_OBJECTIVES[step],
        step,
        total: 4,
        words: EMAIL_WORDS[step],
        cta: EMAIL_CTA[step],
        rules: EMAIL_RULES[step],
        hints: EMAIL_HINTS[step],
      });
      expect(out).toBe(expected);
    });
  }
});

// ── Server resolver (resolveCampaignInstruction + formatInstructionForPrompt) ─

function serverBlock(actionKey: string, motion: string): string {
  return formatInstructionForPrompt(
    resolveCampaignInstruction({
      lead_id: "test-lead",
      action_key: actionKey,
      motion,
    }),
  );
}

describe("SERVER resolver — legacy outbound (send_pre_1..4) byte-identical", () => {
  for (const step of [1, 2, 3, 4]) {
    it(`send_pre_${step}`, () => {
      const out = serverBlock(`send_pre_${step}`, "outbound_prospecting");
      const expected = buildBlock({
        channel: "email",
        framework: OUTBOUND_FRAMEWORK[step],
        objective: OUTBOUND_OBJECTIVES[step],
        step,
        total: 4,
        words: EMAIL_WORDS[step],
        cta: EMAIL_CTA[step],
        rules: EMAIL_RULES[step],
        hints: EMAIL_HINTS[step],
      });
      expect(out).toBe(expected);
    });
  }
});

describe("SERVER resolver — legacy nurture (nurture_1..4) byte-identical", () => {
  for (const step of [1, 2, 3, 4]) {
    it(`nurture_${step}`, () => {
      const out = serverBlock(`nurture_${step}`, "nurture");
      const expected = buildBlock({
        channel: "email",
        framework: SERVER_NURTURE_FRAMEWORK[step],
        objective: NURTURE_OBJECTIVES[step],
        step,
        total: 4,
        words: EMAIL_WORDS[step],
        cta: EMAIL_CTA[step],
        rules: EMAIL_RULES[step],
        hints: EMAIL_HINTS[step],
      });
      expect(out).toBe(expected);
    });
  }
});

// ── Client/server parity on the outbound legacy path (they currently match) ──

describe("client/server parity — legacy outbound", () => {
  for (const step of [1, 2, 3, 4]) {
    it(`send_pre_${step} blocks match across resolvers`, () => {
      const client = buildCampaignPayloadFields({
        action_key: `send_pre_${step}`,
        motion: "outbound_prospecting",
      }).campaign_instruction;
      const server = serverBlock(`send_pre_${step}`, "outbound_prospecting");
      expect(client).toBe(server);
    });
  }
});
