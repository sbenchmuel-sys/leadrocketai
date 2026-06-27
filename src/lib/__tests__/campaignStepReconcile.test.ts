// ============================================================================
// Editable cadence on a saved draft — the safety + reconciliation contract.
//
// Two invariants are load-bearing here and are tested directly:
//   1. A campaign that is actively sending (or has any enrolled people) CANNOT
//      be structurally edited — only a fresh draft can.
//   2. Reordering / inserting / removing a touch renumbers the steps AND tells
//      us exactly how the per-step copy (campaign_step_content) and collateral
//      links — both keyed by step_number — must move: surviving steps' copy
//      follows them, removed steps' copy is dropped, inserted steps start blank.
//
// computeStepReconciliation MIRRORS the SQL in replace_campaign_steps_reconciled;
// these tests pin the mapping the SQL must apply.
// ============================================================================

import { describe, it, expect } from "vitest";

import {
  canEditCampaignSteps,
  computeStepReconciliation,
  effectiveOrigStepNumber,
} from "@/lib/campaignStepReconcile";
import {
  normalizePlan,
  insertStep,
  removeStep,
  moveStep,
  changeStepChannel,
  setStepGap,
  type DraftStep,
} from "@/lib/campaignDefaults";
import type { CanonicalChannel } from "@/lib/channels";

// A saved-draft plan: each touch stamped with its current step_number as its
// identity (orig_step_number), exactly as CampaignDetail projects DB steps.
function savedPlan(defs: Array<{ ch: CanonicalChannel; gap: number }>): DraftStep[] {
  return normalizePlan(
    defs.map((d, i) => ({
      step_number: i + 1,
      step_type: "followup",
      channel: d.ch,
      delay_days: d.gap,
      cta_type: "question",
      custom_instructions: "",
      active: true,
      include_meeting_cta: null,
      orig_step_number: i + 1,
      orig_channel: d.ch,
    })),
  );
}

const origs = (p: DraftStep[]) => p.map((s) => s.orig_step_number ?? null);
const numbers = (p: DraftStep[]) => p.map((s) => s.step_number);

// ── 1. The draft-only safety gate ────────────────────────────────────────────

describe("canEditCampaignSteps — structural edits are draft-only", () => {
  it("allows editing a draft with no enrolled people", () => {
    expect(canEditCampaignSteps("draft", false)).toBe(true);
  });

  it("blocks a draft that somehow already has live cadence rows", () => {
    expect(canEditCampaignSteps("draft", true)).toBe(false);
  });

  it("blocks an actively-sending campaign and every non-draft status", () => {
    expect(canEditCampaignSteps("active", false)).toBe(false);
    expect(canEditCampaignSteps("paused", false)).toBe(false);
    expect(canEditCampaignSteps("completed", false)).toBe(false);
  });

  it("blocks when the status is unknown/missing (fail closed)", () => {
    expect(canEditCampaignSteps(null, false)).toBe(false);
    expect(canEditCampaignSteps(undefined, false)).toBe(false);
    expect(canEditCampaignSteps("", false)).toBe(false);
  });
});

// ── 2. Identity (orig_step_number) survives every editor mutation ─────────────

describe("orig_step_number rides through the shared editor helpers", () => {
  it("reorder renumbers steps 1..N but each touch keeps its prior identity", () => {
    const p = savedPlan([
      { ch: "email", gap: 0 }, // orig 1
      { ch: "voice", gap: 2 }, // orig 2
      { ch: "sms", gap: 2 }, //   orig 3
    ]);
    const next = moveStep(p, 2, -1); // pull the text up one slot
    expect(numbers(next)).toEqual([1, 2, 3]); // renumbered, no gaps
    // The touch that was step 3 now sits in slot 2 but still remembers orig 3.
    expect(origs(next)).toEqual([1, 3, 2]);
  });

  it("a removed touch drops out; the survivors keep their identities", () => {
    const p = savedPlan([
      { ch: "email", gap: 0 }, // orig 1
      { ch: "voice", gap: 2 }, // orig 2
      { ch: "email", gap: 3 }, // orig 3
    ]);
    const next = removeStep(p, 1); // remove the call
    expect(origs(next)).toEqual([1, 3]);
    expect(numbers(next)).toEqual([1, 2]);
  });

  it("an inserted touch has no prior identity (null)", () => {
    const p = savedPlan([
      { ch: "email", gap: 0 }, // orig 1
      { ch: "email", gap: 3 }, // orig 2
    ]);
    const next = insertStep(p, 1, "voice"); // insert a call as the new step 2
    expect(origs(next)).toEqual([1, null, 2]);
  });

  it("retiming a touch leaves its identity intact", () => {
    const p = savedPlan([
      { ch: "email", gap: 0 }, // orig 1
      { ch: "sms", gap: 2 }, //   orig 2
    ]);
    const b = setStepGap(p, 1, 5);
    expect(origs(b)).toEqual([1, 2]);
  });

  it("changing a saved touch's channel DROPS its content (stale channel-shaped copy must not carry over)", () => {
    const p = savedPlan([
      { ch: "email", gap: 0 }, // orig 1
      { ch: "sms", gap: 2 }, //   orig 2, orig_channel sms
    ]);
    // sms → voice: the old text copy is wrong for a call. Identity is PRESERVED
    // in the working copy (so an undo can restore it) but is NOT effective.
    const next = changeStepChannel(p, 1, "voice");
    expect(origs(next)).toEqual([1, 2]); // raw identity kept
    expect(effectiveOrigStepNumber(next[1])).toBeNull(); // but copy not carried
    // So reconciliation drops old step 2's copy; the call starts blank.
    const { map, removed } = computeStepReconciliation(next, [1, 2]);
    expect(removed).toEqual([2]);
    expect(map).toEqual([{ oldNumber: 1, newNumber: 1 }]);
  });

  it("UNDOING a channel change restores the copy (no avoidable data loss)", () => {
    const p = savedPlan([
      { ch: "email", gap: 0 }, // orig 1
      { ch: "sms", gap: 2 }, //   orig 2, orig_channel sms
    ]);
    // sms → voice → back to sms before saving: the final channel matches the
    // saved copy's channel, so its identity is effective again and copy is kept.
    const next = changeStepChannel(changeStepChannel(p, 1, "voice"), 1, "sms");
    expect(effectiveOrigStepNumber(next[1])).toBe(2);
    const { map, removed } = computeStepReconciliation(next, [1, 2]);
    expect(removed).toEqual([]); // nothing deleted — the edit was undone
    expect(map).toEqual([
      { oldNumber: 1, newNumber: 1 },
      { oldNumber: 2, newNumber: 2 },
    ]);
  });
});

// ── 3. The reconciliation mapping the SQL must apply ──────────────────────────

describe("computeStepReconciliation — copy/links follow, drop, or stay blank", () => {
  const ORIGINAL = [1, 2, 3];

  it("reorder: every step survives, copy moves to the new number", () => {
    const p = savedPlan([
      { ch: "email", gap: 0 },
      { ch: "voice", gap: 2 },
      { ch: "sms", gap: 2 },
    ]);
    const next = moveStep(p, 2, -1); // origs become [1,3,2]
    const { map, removed } = computeStepReconciliation(next, ORIGINAL);
    expect(removed).toEqual([]); // nothing deleted
    expect(map).toEqual([
      { oldNumber: 1, newNumber: 1 },
      { oldNumber: 3, newNumber: 2 },
      { oldNumber: 2, newNumber: 3 },
    ]);
  });

  it("remove: the removed step's copy is dropped, the rest renumber", () => {
    const p = savedPlan([
      { ch: "email", gap: 0 },
      { ch: "voice", gap: 2 },
      { ch: "email", gap: 3 },
    ]);
    const next = removeStep(p, 1); // drop step 2; origs [1,3]
    const { map, removed } = computeStepReconciliation(next, ORIGINAL);
    expect(removed).toEqual([2]); // copy for old step 2 is deleted
    expect(map).toEqual([
      { oldNumber: 1, newNumber: 1 },
      { oldNumber: 3, newNumber: 2 }, // old step 3's copy slides to step 2
    ]);
  });

  it("insert: a new step claims no copy; later steps' copy shifts out", () => {
    const p = savedPlan([
      { ch: "email", gap: 0 },
      { ch: "email", gap: 3 },
    ]);
    const next = insertStep(p, 1, "voice"); // origs [1, null, 2]
    const { map, removed } = computeStepReconciliation(next, [1, 2]);
    expect(removed).toEqual([]);
    // The inserted touch (new step 2) is absent from the map → no copy.
    expect(map).toEqual([
      { oldNumber: 1, newNumber: 1 },
      { oldNumber: 2, newNumber: 3 }, // old step 2's copy moves to step 3
    ]);
  });

  it("remove + reorder together: drop one, remap the survivors correctly", () => {
    const p = savedPlan([
      { ch: "email", gap: 0 }, // orig 1
      { ch: "voice", gap: 2 }, // orig 2
      { ch: "sms", gap: 2 }, //   orig 3
      { ch: "email", gap: 2 }, // orig 4
    ]);
    const afterRemove = removeStep(p, 1); // drop orig 2 → origs [1,3,4]
    const afterMove = moveStep(afterRemove, 2, -1); // pull orig 4 up → [1,4,3]
    const { map, removed } = computeStepReconciliation(afterMove, [1, 2, 3, 4]);
    expect(removed).toEqual([2]);
    expect(map).toEqual([
      { oldNumber: 1, newNumber: 1 },
      { oldNumber: 4, newNumber: 2 },
      { oldNumber: 3, newNumber: 3 },
    ]);
  });
});
