// ============================================================================
// CAMPAIGN KNOWLEDGE DOCUMENT VALIDATION (shared, fail-closed)
//
// Single source of truth for deciding whether a campaign's stored
// knowledge_document_id may be trusted to scope KB retrieval. Used by BOTH:
//   • authoring (aiCampaignResolver.resolveCampaignAuthoringInstruction), and
//   • the live send path (automation-executor → ai_task).
//
// WORKSPACE ISOLATION (load-bearing): campaigns.knowledge_document_id is
// member-writable, so a crafted value could point at another tenant's document.
// Before that id is ever used to scope retrieval, confirm the document's
// kb_chunks.owner_user_id is a member of the campaign's OWN workspace. If not
// (or anything is missing / errors), return null — fail closed — so we never
// retrieve another workspace's KB.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type ServiceClient = ReturnType<typeof createClient>;

/**
 * Is `userId` a member of `workspaceId`? Service-role internal callers (no real
 * end-user identity) are trusted infra. Fails closed (false) on error.
 */
export async function isWorkspaceMember(
  client: ServiceClient,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  if (!userId || userId === "service-role") return true;
  const { data, error } = await client
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("[campaignKnowledgeDoc] membership check failed:", error);
    return false; // fail closed
  }
  return !!data;
}

export interface ValidatedCampaignDoc {
  /** The validated kb_chunks.document_id to scope retrieval to. */
  documentId: string;
  /** The document owner to query KB as — verified to be a workspace member. */
  ownerId: string;
}

/**
 * Validate a campaign's knowledge_document_id against its workspace. Returns the
 * validated { documentId, ownerId } when the document's owner is a member of the
 * campaign's workspace, otherwise null (fail closed — none uploaded, missing
 * chunk, foreign owner, or error). Never returns a document/owner pair that
 * crosses the workspace boundary.
 */
export async function validateCampaignKnowledgeDoc(
  client: ServiceClient,
  workspaceId: string | null | undefined,
  documentId: string | null | undefined,
): Promise<ValidatedCampaignDoc | null> {
  if (!workspaceId || !documentId) return null;
  const { data: docChunk, error } = await client
    .from("kb_chunks")
    .select("owner_user_id")
    .eq("document_id", documentId)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[campaignKnowledgeDoc] doc owner lookup failed:", error);
    return null; // fail closed
  }
  const ownerId = (docChunk as { owner_user_id?: string } | null)?.owner_user_id ?? null;
  if (ownerId && (await isWorkspaceMember(client, workspaceId, ownerId))) {
    return { documentId, ownerId };
  }
  console.warn(
    `[campaignKnowledgeDoc] document ${documentId} is not owned by a member of workspace ${workspaceId} — ignoring it (fail closed)`,
  );
  return null;
}

export interface LiveSendKbScope {
  /** kb_chunks.document_id to scope retrieval to. */
  documentFilter: string;
  /** Validated owner to query KB as. */
  ownerId: string;
}

/**
 * Decide whether a LIVE-SEND (non-authoring) ai_task call should scope KB to a
 * campaign document. Pure + dependency-free so the trust gate is unit-testable.
 *
 * Returns the scope ONLY when a TRUSTED service-role caller (automation-executor)
 * supplies BOTH a campaign doc id and its validated owner; otherwise null →
 * standard owner-scoped retrieval (unchanged). The isServiceRole gate is the
 * load-bearing guarantee: an untrusted user JWT can never supply a KB owner and
 * thereby read another tenant's KB.
 */
export function resolveLiveSendCampaignKbScope(args: {
  isServiceRole: boolean;
  campaignKnowledgeDocId: unknown;
  campaignKbOwnerId: unknown;
}): LiveSendKbScope | null {
  if (!args.isServiceRole) return null;
  const documentFilter = args.campaignKnowledgeDocId ? String(args.campaignKnowledgeDocId) : null;
  const ownerId = args.campaignKbOwnerId ? String(args.campaignKbOwnerId) : null;
  if (documentFilter && ownerId) return { documentFilter, ownerId };
  return null;
}
