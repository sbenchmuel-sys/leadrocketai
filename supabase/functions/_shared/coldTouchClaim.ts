// ============================================================================
// Cold-touch claim — PURE dedup primitives (zero-dependency leaf)
//
// The per-touch double-send guard in automation-executor is enforced at the
// DATABASE layer by the unique index automation_log_claim_unique
// (lead_id, action_key, claim_date): a concurrent run that tries to insert the
// same claim gets a 23505 and skips. That index can only be exercised against a
// real database, so it is NOT unit-testable here.
//
// What IS pure — and what these two helpers pin so it can't silently regress —
// is the application side of the guard:
//   1. coldTouchClaimKey: the action_key is a deterministic function of the
//      globally-unique touch id, so the SAME touch always maps to the SAME claim
//      row (the lifetime + per-day dedup key) and two DIFFERENT touches never
//      collide on a key.
//   2. coldTouchClaimAcquired: a send may proceed ONLY when the claim insert
//      both returned no error AND produced a row. Any error (including the 23505
//      "already claimed by a concurrent run") or a missing row means the claim
//      was NOT won → the caller must refuse to send.
//
// Nothing here touches the network, the database, Deno, or supabase-js.
// ============================================================================

/**
 * The per-touch claim key. Embeds the globally-unique touch id, so it is stable
 * for a given touch and distinct across touches — the basis of the unique-index
 * dedup. Must stay `cold_touch_<id>` (the executor's lifetime-sent lookup and the
 * claim insert both key on this exact string).
 */
export function coldTouchClaimKey(touchId: string): string {
  return `cold_touch_${touchId}`;
}

/**
 * Whether the pre-send claim was won. Sending is allowed ONLY when the insert
 * returned no error AND a claim row came back. A duplicate-key error (23505) from
 * a racing run, any other insert error, or a null row all mean "not claimed" →
 * the caller must skip (no double-send).
 */
export function coldTouchClaimAcquired(error: unknown, claimRow: unknown): boolean {
  return !error && claimRow != null;
}
