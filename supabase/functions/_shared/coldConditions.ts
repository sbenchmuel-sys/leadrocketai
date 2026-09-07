// ============================================================
// coldConditions — cadence step conditions (Outreach Sprint 3).
//
// A campaign_steps row may carry `condition`; when its touch comes due and the
// condition isn't met, the caller auto-skips the touch (advanceColdEnrollment
// with the reason below, which lands on the lead's timeline) and the cadence
// moves on. Signals, all already in the data:
//   linkedin_accepted  — leads.linkedin_connected_at IS NOT NULL (rep-marked)
//   call_answered      — a voice touch in THIS enrollment has call_outcome 'got_them'
//   no_call_answered   — the opposite
// Unknown/NULL condition = always met (fail OPEN on the condition itself: a
// typo in the column must not silently skip every step — the CHECK constraint
// keeps the column honest anyway).
// ============================================================

export type StepCondition = "linkedin_accepted" | "call_answered" | "no_call_answered";

export interface ConditionSignals {
  linkedinAccepted: boolean;
  callAnswered: boolean;
}

/** Plain-words reason for the timeline note when a condition is not met. */
export const CONDITION_UNMET_REASON: Record<StepCondition, string> = {
  linkedin_accepted: "this step only runs once they've accepted the LinkedIn invite, and they hadn't yet",
  call_answered: "this step only runs after a call was answered, and none was",
  no_call_answered: "this step only runs if no call was answered, but one was",
};

/** null = met (or no condition); otherwise the reason it isn't. Pure. */
export function evaluateStepCondition(
  condition: string | null | undefined,
  signals: ConditionSignals,
): string | null {
  switch (condition) {
    case "linkedin_accepted": return signals.linkedinAccepted ? null : CONDITION_UNMET_REASON.linkedin_accepted;
    case "call_answered": return signals.callAnswered ? null : CONDITION_UNMET_REASON.call_answered;
    case "no_call_answered": return signals.callAnswered ? CONDITION_UNMET_REASON.no_call_answered : null;
    default: return null;
  }
}

// deno-lint-ignore no-explicit-any
type ServiceClient = any;

/**
 * Load the step's condition and the enrollment's signals, and evaluate.
 * Returns null when the touch may run; otherwise the reason to auto-skip it.
 * One extra read for the common (unconditional) case; signals are only fetched
 * when a condition exists.
 *
 * FAILS CLOSED on a read error: supabase-js resolves `{ data: null, error }`
 * rather than throwing, and a swallowed error here would read as "no
 * condition" — i.e. send an automatic email whose condition was never checked.
 * So any query error THROWS; callers leave the touch pending for the next tick.
 */
export async function stepConditionUnmetReason(
  supabase: ServiceClient,
  touch: { campaign_id: string; step_number: number; enrollment_id: string; lead_id: string },
): Promise<string | null> {
  const stepRes = await supabase
    .from("campaign_steps")
    .select("condition")
    .eq("campaign_id", touch.campaign_id)
    .eq("step_number", touch.step_number)
    .maybeSingle();
  if (stepRes.error) throw new Error(`step condition read failed: ${stepRes.error.message}`);
  const condition = (stepRes.data as { condition?: string | null } | null)?.condition ?? null;
  if (!condition) return null;

  const [leadRes, answeredRes] = await Promise.all([
    supabase.from("leads").select("linkedin_connected_at").eq("id", touch.lead_id).maybeSingle(),
    supabase
      .from("campaign_touch")
      .select("id")
      .eq("enrollment_id", touch.enrollment_id)
      .eq("channel", "voice")
      .eq("call_outcome", "got_them")
      .limit(1),
  ]);
  if (leadRes.error) throw new Error(`condition signal read failed: ${leadRes.error.message}`);
  if (answeredRes.error) throw new Error(`condition signal read failed: ${answeredRes.error.message}`);
  return evaluateStepCondition(condition, {
    linkedinAccepted: !!(leadRes.data as { linkedin_connected_at?: string | null } | null)?.linkedin_connected_at,
    callAnswered: ((answeredRes.data as unknown[] | null) || []).length > 0,
  });
}
