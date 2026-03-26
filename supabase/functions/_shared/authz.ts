// ============================================================
// Shared authorization helpers for edge functions
// Deterministic access checks — no silent failures
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logger } from "./logger.ts";

type SupabaseClient = ReturnType<typeof createClient>;

export interface AuthzResult {
  ok: boolean;
  error?: string;
  status?: number;
  workspaceId?: string;
}

// ── Internal caller verification ────────────────────────────
// Used by edge functions that are called by other edge functions
// (e.g. automation-executor → gmail-send) or by pg_cron triggers.
// Callers pass: X-Internal-Secret: <value of INTERNAL_API_SECRET>
// This is the ONLY privileged bypass — anon key is NOT privileged.

export function isInternalCaller(req: Request): boolean {
  const secret = req.headers.get("X-Internal-Secret");
  if (!secret) return false;
  const expected = Deno.env.get("INTERNAL_API_SECRET");
  if (!expected) {
    logger.warn("authz_internal_secret_not_configured");
    return false;
  }
  // Constant-time-ish comparison
  if (secret.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < secret.length; i++) {
    mismatch |= secret.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Check if the Bearer token is the service-role key.
 * Use sparingly — prefer isInternalCaller for edge-to-edge calls.
 */
export function isServiceRoleToken(req: Request): boolean {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return !!token && token === serviceKey;
}

/**
 * Resolve the authenticated user from the request's Authorization header.
 * Returns null if no valid user session is present.
 * Does NOT treat anon key as privileged.
 */
export async function resolveUser(req: Request): Promise<{ userId: string } | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data, error } = await userClient.auth.getUser();
  if (error || !data?.user) return null;
  return { userId: data.user.id };
}

/**
 * Require either internal-secret or service-role authentication.
 * Returns a standard 401/403 response on failure, or null on success.
 * Use for system-only endpoints (automation-executor, cron jobs).
 */
export function requirePrivilegedCaller(req: Request, corsHeaders: Record<string, string>): Response | null {
  if (isInternalCaller(req) || isServiceRoleToken(req)) return null;
  return new Response(JSON.stringify({ error: "Forbidden — requires internal or service-role auth" }), {
    status: 403,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Require user auth OR internal/service-role auth.
 * Returns { userId, isPrivileged } on success or a Response on failure.
 */
export async function requireAuth(
  req: Request,
  corsHeaders: Record<string, string>,
): Promise<{ userId: string | null; isPrivileged: boolean } | Response> {
  // Internal/service-role callers are privileged (no user scoping)
  if (isInternalCaller(req) || isServiceRoleToken(req)) {
    return { userId: null, isPrivileged: true };
  }

  // Otherwise require a valid user JWT
  const user = await resolveUser(req);
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return { userId: user.userId, isPrivileged: false };
}

/**
 * Assert workspace membership for a call session.
 * Returns the workspace_id on success.
 */
export async function assertCallSessionAccess(
  admin: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<AuthzResult> {
  const { data: session, error } = await admin
    .from("call_sessions")
    .select("workspace_id")
    .eq("id", sessionId)
    .maybeSingle();

  if (error || !session) {
    return { ok: false, error: "Call session not found", status: 404 };
  }

  return assertWorkspaceMembership(admin, session.workspace_id, userId);
}

/**
 * Verify the caller can access a lead.
 *
 * Conservative rules (until leads gain workspace_id in Phase 2):
 *  1. Allow if lead.owner_user_id === userId  (direct ownership)
 *  2. Allow if a `contacts` row with contacts.lead_id = leadId exists
 *     in a workspace the caller belongs to  (explicit workspace link)
 *  3. Deny otherwise
 *
 * This intentionally does NOT allow access just because the caller
 * shares "any" workspace with the lead owner — that would over-authorize
 * when a user belongs to multiple workspaces.
 */
export async function assertLeadAccess(
  admin: SupabaseClient,
  leadId: string,
  userId: string,
): Promise<AuthzResult> {
  // Step 1: Fetch lead
  const { data: lead, error } = await admin
    .from("leads")
    .select("owner_user_id")
    .eq("id", leadId)
    .maybeSingle();

  if (error || !lead) {
    logger.warn("authz_lead_not_found", { leadId, userId });
    return { ok: false, error: "Lead not found", status: 404 };
  }

  // Rule 1: Direct ownership
  if (lead.owner_user_id === userId) {
    return { ok: true };
  }

  // Rule 2: Lead is linked to a contact in a workspace the caller belongs to
  const { data: linkedContacts } = await admin
    .from("contacts")
    .select("workspace_id")
    .eq("lead_id", leadId)
    .limit(10);

  if (linkedContacts && linkedContacts.length > 0) {
    const wsIds = [...new Set(linkedContacts.map((c: any) => c.workspace_id))];
    const { data: membership } = await admin
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", userId)
      .in("workspace_id", wsIds)
      .limit(1);

    if (membership && membership.length > 0) {
      return { ok: true, workspaceId: membership[0].workspace_id };
    }
  }

  logger.warn("authz_lead_denied", { leadId, userId, ownerId: lead.owner_user_id });
  return { ok: false, error: "Access denied to this lead", status: 403 };
}

/**
 * Verify the caller is a member of the given workspace.
 */
export async function assertWorkspaceMembership(
  admin: SupabaseClient,
  workspaceId: string,
  userId: string,
): Promise<AuthzResult> {
  const { data, error } = await admin
    .from("workspace_members")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    logger.warn("authz_workspace_denied", { workspaceId, userId });
    return { ok: false, error: "Not a member of this workspace", status: 403 };
  }

  return { ok: true, workspaceId };
}

/**
 * Verify the caller can access a conversation.
 *
 * Rules:
 *  - Conversation must exist
 *  - userId must be a member of the conversation's workspace
 *
 * Returns the resolved workspaceId on success for downstream use.
 * This is the single authoritative check — callers should NOT also
 * call assertWorkspaceMembership separately.
 */
export async function assertConversationAccess(
  admin: SupabaseClient,
  conversationId: string,
  userId: string,
): Promise<AuthzResult> {
  const { data: convo, error } = await admin
    .from("conversations")
    .select("workspace_id, owner_user_id")
    .eq("id", conversationId)
    .maybeSingle();

  if (error || !convo) {
    logger.warn("authz_conversation_not_found", { conversationId, userId });
    return { ok: false, error: "Conversation not found", status: 404 };
  }

  const memberCheck = await assertWorkspaceMembership(admin, convo.workspace_id, userId);
  if (!memberCheck.ok) {
    logger.warn("authz_conversation_denied", { conversationId, userId, workspaceId: convo.workspace_id });
    return { ok: false, error: "Access denied to this conversation", status: 403 };
  }

  return { ok: true, workspaceId: convo.workspace_id };
}
