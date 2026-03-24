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
}

/**
 * Verify the caller owns or has workspace access to a lead.
 * Rules:
 *  - Lead must exist
 *  - userId must equal lead.owner_user_id, OR
 *  - userId must be a member of any workspace the lead owner belongs to
 */
export async function assertLeadAccess(
  admin: SupabaseClient,
  leadId: string,
  userId: string,
): Promise<AuthzResult> {
  const { data: lead, error } = await admin
    .from("leads")
    .select("owner_user_id")
    .eq("id", leadId)
    .maybeSingle();

  if (error || !lead) {
    logger.warn("authz_lead_not_found", { leadId, userId });
    return { ok: false, error: "Lead not found", status: 404 };
  }

  if (lead.owner_user_id === userId) {
    return { ok: true };
  }

  // Check if both users share a workspace
  const { data: ownerWs } = await admin
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", lead.owner_user_id);

  if (ownerWs && ownerWs.length > 0) {
    const wsIds = ownerWs.map((w: any) => w.workspace_id);
    const { data: shared } = await admin
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", userId)
      .in("workspace_id", wsIds)
      .limit(1);

    if (shared && shared.length > 0) {
      return { ok: true };
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

  return { ok: true };
}

/**
 * Verify the caller can access a conversation.
 * Rules:
 *  - Conversation must exist
 *  - userId must be a member of the conversation's workspace
 */
export async function assertConversationAccess(
  admin: SupabaseClient,
  conversationId: string,
  userId: string,
): Promise<AuthzResult & { workspaceId?: string }> {
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
