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
// (e.g. automation-executor → gmail-send).
// Callers pass: X-Internal-Secret: <value of INTERNAL_API_SECRET>
// This replaces the old pattern of comparing Bearer token to SUPABASE_SERVICE_ROLE_KEY.

export function isInternalCaller(req: Request): boolean {
  const secret = req.headers.get("X-Internal-Secret");
  if (!secret) return false;
  const expected = Deno.env.get("INTERNAL_API_SECRET");
  if (!expected) {
    logger.warn("authz_internal_secret_not_configured");
    return false;
  }
  // Constant-time-ish comparison (good enough for edge functions;
  // Deno doesn't expose crypto.timingSafeEqual for strings)
  if (secret.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < secret.length; i++) {
    mismatch |= secret.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
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
