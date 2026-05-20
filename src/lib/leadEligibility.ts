// Lead-level eligibility helpers for bulk operations.
//
// Pattern mirrors `categorizeLead` in
// src/components/dashboard/BulkAutomationDialog.tsx — partition each
// selected lead into `{ eligible, flag }` so the bulk-confirm dialog
// can show the rep which leads would be affected before they commit.
//
// Phase 1.5 introduces only one categorizer here (bulk-move-to-nurture).
// When Phase 2b lifts BulkAutomationDialog's in-component
// `categorizeLead` out for reuse, it lands alongside this one.

import type { EnrichedLead } from "./dashboardUtils";

export type NurtureMoveFlag = "active_outbound_sequence";

export interface NurtureMoveCategorization {
  lead: EnrichedLead;
  eligible: boolean;
  flag: NurtureMoveFlag | null;
}

// `outbound_prospecting` and `inbound_response` are the two motions that
// the executor treats as live-sender outbound flows. `nurture` and the
// meeting/closing/closed motions are excluded — flipping them to nurture
// either has no in-flight sequence to clobber or is a no-op.
const OUTBOUND_SENDER_MOTIONS: ReadonlySet<string> = new Set([
  "outbound_prospecting",
  "inbound_response",
]);

// `automation_mode === 'full_auto'` is the executor's consent gate
// (see supabase/functions/_shared/syncEngine.ts) — a lead without this
// flag will not have automation firing against it, so moving it to
// nurture cannot clobber an in-flight sequence.
const LIVE_SENDER_MODE = "full_auto";

/**
 * Bulk move-to-nurture categorization.
 *
 * BLOCKED if the lead currently has the executor consent gate set
 * (`automation_mode='full_auto'`) AND is on an outbound sender motion.
 * Flipping such a lead to nurture silently cuts off the in-progress
 * sequence; the rep should explicitly opt in.
 *
 * Otherwise ELIGIBLE — including leads already on nurture (the move
 * is a no-op for them).
 */
export function categorizeForNurtureMove(
  lead: EnrichedLead,
): NurtureMoveCategorization {
  const automationMode =
    (lead as { automation_mode?: string | null }).automation_mode ?? null;
  const motion = lead.motion;

  const isLiveSender = automationMode === LIVE_SENDER_MODE;
  const isOutboundMotion = motion ? OUTBOUND_SENDER_MOTIONS.has(motion) : false;

  if (isLiveSender && isOutboundMotion) {
    return { lead, eligible: false, flag: "active_outbound_sequence" };
  }
  return { lead, eligible: true, flag: null };
}
