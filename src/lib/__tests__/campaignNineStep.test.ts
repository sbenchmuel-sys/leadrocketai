// ============================================================================
// Unit B — new behavior locks for the 4→9 cadence extension.
// Complements campaignResolver.golden.test.ts (which proves the legacy
// 4-step path is unchanged). Here we prove the NEW capabilities work:
//   • steps 5–9 resolve by rule (step_type tier) instead of intro defaults,
//   • total_steps reflects the real count only when > 4 (conservative),
//   • the pure send-eligibility gate behaves per the draft-gate spec.
// ============================================================================

import { describe, it, expect } from "vitest";

import {
  getStructuredStepConfig,
  isCampaignSendable,
  type LoadedCampaign,
  type StructuredCampaignStep,
} from "../../../supabase/functions/_shared/campaignStepConfig";
import {
  resolveCampaignInstruction,
  formatInstructionForPrompt,
} from "../../../supabase/functions/_shared/campaignResolver";

// ── Builders ────────────────────────────────────────────────────────────────

function step(
  n: number,
  step_type: string,
  cta_type: string,
  overrides: Partial<StructuredCampaignStep> = {},
): StructuredCampaignStep {
  return {
    step_number: n,
    step_type,
    channel: "email",
    framework: null,
    objective: null,
    cta_type,
    max_word_count: null,
    hard_rules: [],
    generation_hints: [],
    custom_instructions: null,
    delay_days: 3,
    active: true,
    variant_group: null,
    ...overrides,
  };
}

// Mirrors the Unit A default 9-touch plan's step_types (channels collapsed to
// email here so the test exercises the email constraint tiers deterministically).
function nineStepCampaign(): LoadedCampaign {
  return {
    id: "camp-9",
    motion: "outbound_prospecting",
    default_channel: "email",
    include_meeting_cta: false,
    global_instructions: null,
    steps: [
      step(1, "intro", "question"),
      step(2, "followup", "question"),
      step(3, "followup", "question"),
      step(4, "value_add", "soft_offer"),
      step(5, "followup", "question"),
      step(6, "value_add", "soft_offer"),
      step(7, "followup", "question"),
      step(8, "followup", "question"),
      step(9, "breakup", "breakup_close"),
    ],
  };
}

// ── Rule-based config for extended steps (> 4) ──────────────────────────────

describe("getStructuredStepConfig — extended steps resolve by step_type, not intro defaults", () => {
  const camp = nineStepCampaign();

  it("step 3 (followup) uses the followup tier, NOT the ordinal value_add tier", () => {
    const cfg = getStructuredStepConfig(camp, 3)!;
    expect(cfg.framework).toBe("hypothesis"); // followup, not ordinal-3 value_add
    expect(cfg.max_words).toBe(60); // email tier 2
    expect(cfg.hard_rules).toContain("One question only"); // email[2]
    expect(cfg.hard_rules).not.toContain("Lead with one concrete insight or result"); // email[3]
  });

  it("step 4 (value_add) uses the value_add tier, NOT the ordinal breakup tier", () => {
    const cfg = getStructuredStepConfig(camp, 4)!;
    expect(cfg.framework).toBe("value_add"); // not ordinal-4 breakup
    expect(cfg.max_words).toBe(60); // email tier 3
    expect(cfg.hard_rules).toContain("Lead with one concrete insight or result"); // email[3]
    expect(cfg.hard_rules).not.toContain("No guilt, no fake urgency"); // email[4]
  });

  it("step 6 (value_add) borrows the value_add tier (email step 3)", () => {
    const cfg = getStructuredStepConfig(camp, 6)!;
    expect(cfg.framework).toBe("value_add");
    expect(cfg.objective).toBe("Share proof or value — make it easy to say yes");
    expect(cfg.max_words).toBe(60); // email tier 3
    expect(cfg.cta_type).toBe("soft_offer");
    expect(cfg.hard_rules).toContain("Lead with one concrete insight or result");
    // NOT the intro-tier rule — proves we didn't fall back to step 1.
    expect(cfg.hard_rules).not.toContain("2 short paragraphs max");
  });

  it("step 9 (breakup) borrows the breakup tier (email step 4)", () => {
    const cfg = getStructuredStepConfig(camp, 9)!;
    expect(cfg.framework).toBe("breakup");
    expect(cfg.max_words).toBe(40); // email tier 4
    expect(cfg.cta_type).toBe("breakup_close");
    expect(cfg.hard_rules).toContain("No guilt, no fake urgency");
  });

  it("an explicit DB value still wins over the rule", () => {
    const camp2 = nineStepCampaign();
    camp2.steps[5] = step(6, "value_add", "soft_offer", {
      framework: "hypothesis",
      max_word_count: 99,
    });
    const cfg = getStructuredStepConfig(camp2, 6)!;
    expect(cfg.framework).toBe("hypothesis");
    expect(cfg.max_words).toBe(99);
  });
});

// ── Short (≤4) campaigns keep ORDINAL tiers — byte-identical, even with an
//    unusual step_type ordering. Proves the length gate (not step_type) governs. ─

describe("getStructuredStepConfig — ≤4-step campaigns use ordinal tiers (unchanged)", () => {
  it("a value_add at step 2 of a 4-step campaign still resolves with the ordinal-2 tier", () => {
    const camp: LoadedCampaign = {
      id: "camp-4b",
      motion: "outbound_prospecting",
      default_channel: "email",
      include_meeting_cta: false,
      global_instructions: null,
      steps: [
        step(1, "intro", "question"),
        step(2, "value_add", "soft_offer"), // unusual: value_add at ordinal 2
        step(3, "value_add", "soft_offer"),
        step(4, "breakup", "breakup_close"),
      ],
    };
    const cfg = getStructuredStepConfig(camp, 2)!;
    // Ordinal-2 (followup) defaults win — NOT the value_add tier — so existing
    // ≤4-step campaigns are unaffected by the step_type-tier logic.
    expect(cfg.framework).toBe("hypothesis");
    expect(cfg.max_words).toBe(60);
    expect(cfg.hard_rules).toContain("One question only");
  });
});

// ── total_steps is conservative ─────────────────────────────────────────────

describe("resolveCampaignInstruction — total_steps reflects real count only when > 4", () => {
  it("9-step campaign → 'Step 6 of 9'", () => {
    const resolved = resolveCampaignInstruction({
      lead_id: "L",
      action_key: "send_pre_6",
      motion: "outbound_prospecting",
      structured_campaign: nineStepCampaign(),
    });
    expect(resolved.sequence_context.step_number).toBe(6);
    expect(resolved.sequence_context.total_steps).toBe(9);
    expect(resolved.framework).toBe("value_add");
    expect(formatInstructionForPrompt(resolved)).toContain("Sequence: Step 6 of 9");
  });

  it("structured campaign raises the clamp: send_pre_15 → step 9 (capped at active count)", () => {
    const resolved = resolveCampaignInstruction({
      lead_id: "L",
      action_key: "send_pre_15",
      motion: "outbound_prospecting",
      structured_campaign: nineStepCampaign(),
    });
    expect(resolved.sequence_context.step_number).toBe(9);
    expect(resolved.framework).toBe("breakup");
  });

  it("4-step structured campaign still shows 'of 4' (no live-send change)", () => {
    const camp: LoadedCampaign = {
      id: "camp-4",
      motion: "outbound_prospecting",
      default_channel: "email",
      include_meeting_cta: false,
      global_instructions: null,
      steps: [
        step(1, "intro", "question"),
        step(2, "followup", "question"),
        step(3, "value_add", "soft_offer"),
        step(4, "breakup", "breakup_close"),
      ],
    };
    const resolved = resolveCampaignInstruction({
      lead_id: "L",
      action_key: "send_pre_2",
      motion: "outbound_prospecting",
      structured_campaign: camp,
    });
    expect(resolved.sequence_context.total_steps).toBe(4);
  });
});

// ── Draft-gate (pure) — re #5: draft/paused/completed never drive sends ──────

describe("isCampaignSendable — the send-path status gate", () => {
  it("active sends", () => {
    expect(isCampaignSendable("active")).toBe(true);
  });
  it("missing status fails safe to sendable (pre-migration rows)", () => {
    expect(isCampaignSendable(null)).toBe(true);
    expect(isCampaignSendable(undefined)).toBe(true);
  });
  it.each(["draft", "paused", "completed"])("%s does NOT send", (status) => {
    expect(isCampaignSendable(status)).toBe(false);
  });
});
