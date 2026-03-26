// ============================================================
// Shared auth helper for scheduled / cron-dispatched edge functions
//
// Standardizes how cron-target functions verify their caller.
// Accepts X-Internal-Secret (primary) or service-role Bearer token.
// Returns a typed result so callers can immediately return a 401/403.
//
// Usage:
//   const auth = requireScheduledCaller(req, corsHeaders);
//   if (auth instanceof Response) return auth;
//   // auth.source is "internal_secret" | "service_role"
// ============================================================

import { isInternalCaller, isServiceRoleToken } from "./authz.ts";

export interface ScheduledAuthResult {
  ok: true;
  source: "internal_secret" | "service_role";
}

/**
 * Verify that the request comes from a trusted internal source.
 * Returns a Response (401/403) on failure, or ScheduledAuthResult on success.
 *
 * This is the SINGLE auth gate for all cron-target edge functions.
 * Do NOT duplicate this logic — import and call this helper.
 */
export function requireScheduledCaller(
  req: Request,
  corsHeaders: Record<string, string>,
): ScheduledAuthResult | Response {
  if (isInternalCaller(req)) {
    return { ok: true, source: "internal_secret" };
  }
  if (isServiceRoleToken(req)) {
    return { ok: true, source: "service_role" };
  }
  return new Response(
    JSON.stringify({ error: "Unauthorized — requires internal or service-role auth" }),
    {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}
