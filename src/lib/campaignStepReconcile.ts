// ============================================================================
// Editable cadence — reconciliation contract (pure, testable mirror of the SQL).
//
// A saved campaign's per-step copy (campaign_step_content) and collateral links
// (campaign_collateral.attached_step_number) are keyed by step_number, not by a
// step id. Reordering / inserting / deleting steps renumbers them, so those
// dependents must be reconciled or they point at the wrong step.
//
// The actual reconciliation runs ATOMICALLY in the SQL function
// replace_campaign_steps_reconciled. The helpers here:
//   • computeStepReconciliation — documents and tests the exact old→new mapping
//     and the removed set the SQL applies (keep the two in sync).
//   • canEditCampaignSteps      — the single gate deciding whether the editor is
//     even offered (draft + no live cadence rows). The SQL enforces the same
//     rule server-side; this is the UI mirror so we never show an editor that
//     would be rejected.
// ============================================================================

import type { DraftStep } from "./campaignDefaults";

/** Campaign statuses where structural step edits are allowed. Draft only. */
const EDITABLE_STATUSES = new Set(["draft"]);

/**
 * Whether the cadence steps may be structurally edited.
 *
 * Structural edits renumber steps; a live (active/paused/completed) campaign has
 * already laid out every enrolled lead's touch schedule with step_number baked
 * in, and the cadence engine advances by step_number — renumbering under it
 * would corrupt in-flight sends. So we only ever edit a DRAFT that has no
 * enrollments/touches yet. Mirrors the server-side guard in the RPC.
 */
export function canEditCampaignSteps(
  status: string | null | undefined,
  hasLiveCadenceRows: boolean,
): boolean {
  return !!status && EDITABLE_STATUSES.has(status) && !hasLiveCadenceRows;
}

/**
 * The step_number whose saved copy/links this edited touch may carry forward —
 * or null if its copy must be dropped. Identity is preserved only while the
 * channel still matches what the copy was generated for (orig_channel), because
 * campaign_step_content is channel-shaped. A channel change drops it; undoing
 * that change (channel back to orig_channel) restores it, so an effectively-
 * undone edit never loses copy. A touch with no prior identity returns null.
 */
export function effectiveOrigStepNumber(
  step: Pick<DraftStep, "orig_step_number" | "orig_channel" | "channel">,
): number | null {
  if (step.orig_step_number == null) return null;
  if (step.orig_channel != null && step.orig_channel !== step.channel) return null;
  return step.orig_step_number;
}

export interface StepReconciliation {
  /** Surviving steps: prior step_number → new step_number (1-based final order). */
  map: Array<{ oldNumber: number; newNumber: number }>;
  /** Prior step_numbers whose touch was removed — their copy/links are dropped. */
  removed: number[];
}

/**
 * Work out how per-step copy and collateral links (both keyed by step_number)
 * must move when an edited plan is saved:
 *   • a SURVIVING step (orig_step_number set) → its copy moves to the new number,
 *   • a REMOVED step (in originalNumbers, absent from the edited plan) → dropped,
 *   • an INSERTED step (orig_step_number == null) → starts with no copy.
 *
 * MIRRORS replace_campaign_steps_reconciled — if you change one, change both.
 */
export function computeStepReconciliation(
  editedPlan: Array<Pick<DraftStep, "orig_step_number" | "orig_channel" | "channel">>,
  originalNumbers: number[],
): StepReconciliation {
  const map: Array<{ oldNumber: number; newNumber: number }> = [];
  const survivingOld = new Set<number>();
  editedPlan.forEach((s, i) => {
    // effectiveOrigStepNumber, not the raw field: a step whose channel no longer
    // matches its saved copy is treated as content-removed (copy dropped, step
    // starts blank) even though its position-identity is still tracked.
    const old = effectiveOrigStepNumber(s);
    if (old != null) {
      map.push({ oldNumber: old, newNumber: i + 1 });
      survivingOld.add(old);
    }
  });
  const removed = originalNumbers.filter((n) => !survivingOld.has(n));
  return { map, removed };
}
