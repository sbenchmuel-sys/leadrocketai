// ============================================================================
// Cold reply-stop rule (Outreach Unit C) — the single source of truth for
// "has this lead replied since we committed them to the cadence?"
//
// Kept in its OWN zero-dependency leaf module (no Deno / supabase-js imports) so it
// can be imported and unit-tested from the Node/vitest suite. coldOutreach.ts
// re-exports it, so every cold send path applies the rule identically.
// ============================================================================

/**
 * True when the lead has replied since being COMMITTED to the cadence — anchored to
 * enrolled_at (when the enrollment row was created), NOT started_at.
 *
 * started_at is the lead's day-0 SEND anchor, which for a STAGGERED large list can be
 * days in the future. Anchoring the reply check there meant a reply that landed AFTER
 * enrollment but BEFORE the staggered start day did not stop the first touch — the lead
 * got cold-emailed even though they'd already written back. enrolled_at closes that
 * window. For a non-staggered lead enrolled_at ≈ started_at, so behavior is unchanged in
 * the common case; a reply that PREDATES enrollment (an old/warm thread) is correctly
 * ignored because its timestamp is before enrolled_at.
 *
 * FAIL-SAFE DIRECTION. A `true` result STOPS the touch; `false` lets the cadence send.
 * So on uncertainty this must lean toward `true` (suppress), never toward a send:
 *   - No inbound on record (null/empty last_inbound_at) → `false`. This is NOT
 *     uncertainty — the column is null precisely because the lead has never replied, so
 *     there is nothing to honor and the cold cadence proceeds. (Suppressing here would
 *     stop every never-replied lead, i.e. all of cold outreach.)
 *   - An inbound timestamp IS present but it — or the enrollment baseline — is
 *     missing/unparseable (NaN) → `true` (suppress). We have evidence the lead wrote in
 *     but cannot prove it predates enrollment, so we must not send.
 *   - Both parse cleanly → the real comparison (inbound strictly after enrolled_at).
 *
 * Pure + deterministic → unit-testable. Callers still re-read the lead FRESH right
 * before sending; this only decides the comparison, not when it runs.
 */
export function repliedSinceEnrollment(
  lastInboundAt: string | null | undefined,
  enrolledAt: string | null | undefined,
): boolean {
  // No inbound on record → genuinely never replied → nothing to honor, cadence proceeds.
  if (!lastInboundAt) return false;
  // An inbound exists. From here, err toward SUPPRESS whenever we cannot positively
  // prove it predates enrollment.
  const inboundMs = new Date(lastInboundAt).getTime();
  if (Number.isNaN(inboundMs)) return true;  // present but malformed → suppress
  if (!enrolledAt) return true;              // inbound exists, no baseline to compare → suppress
  const enrolledMs = new Date(enrolledAt).getTime();
  if (Number.isNaN(enrolledMs)) return true; // can't compare → suppress
  return inboundMs > enrolledMs;
}
