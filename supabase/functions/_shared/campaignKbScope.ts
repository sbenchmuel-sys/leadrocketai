// ============================================================================
// CAMPAIGN-AUTHORING KB SCOPE DECISION (Unit A — no-file workspace fallback)
//
// Pure, dependency-free decision for how ai_task's campaign-authoring branch
// scopes knowledge-base retrieval. Extracted so the branch can be unit-tested
// without standing up the whole ai_task serve() handler.
//
// WHY THE SINGLE-WORKSPACE GATE (load-bearing — workspace isolation):
//   KB chunks are keyed by owner_user_id ONLY — there is no workspace_id on
//   kb_chunks and no workspace parameter on match_knowledge_chunks_v2. A campaign
//   belongs to a workspace, but a user can belong to MORE THAN ONE workspace. So
//   falling back to "all of resolvedUserId's KB" would, for a multi-workspace
//   user, surface KB they uploaded for workspace B inside a workspace-A campaign.
//   To stay provably isolated WITHOUT a schema change, the workspace_fallback
//   only fires when the authoring user belongs to EXACTLY ONE workspace — then
//   their KB is unambiguously that single workspace's KB (and the resolver has
//   already verified they're a member of the campaign's workspace, so the two are
//   the same). Multi-workspace users fail closed to no search (the prior no-doc
//   behavior), never a cross-workspace fallback.
//
// FAIL-CLOSED CONTRACT:
//   resolveCampaignAuthoringInstruction() only ever returns a non-null
//   knowledgeDocumentId together with a workspace-verified knowledgeDocOwnerId;
//   when the stored document id is foreign / owned by a non-member, BOTH are
//   nulled together. This helper additionally requires BOTH to be present before
//   it will scope to a document (defense in depth), so a document id can never be
//   used without its validated owner.
// ============================================================================

export type CampaignKbScope =
  | { scope: "campaign_doc"; kbOwnerId: string; documentFilter: string }
  | { scope: "workspace_fallback"; kbOwnerId: string; documentFilter: undefined }
  | {
      scope: "none";
      kbOwnerId: undefined;
      documentFilter: undefined;
      reason: "no_query" | "multi_workspace_author";
    };

export interface CampaignKbScopeArgs {
  /** Whether there is a non-empty, long-enough query to embed (length gate already applied). */
  hasSearchableQuery: boolean;
  /** Validated campaign document id, or null when none/foreign (resolver fails closed). */
  campaignKnowledgeDocId: string | null;
  /** Workspace-verified owner of that document, or null when none/foreign. */
  campaignKbOwnerId: string | null;
  /** The authoring user — the only safe fallback KB owner. */
  resolvedUserId: string;
  /**
   * Whether the authoring user belongs to EXACTLY ONE workspace. Only consulted
   * on the no-validated-doc fallback branch. When false, the fallback is disabled
   * (fail closed) because resolvedUserId's KB could span multiple workspaces.
   */
  authorIsSingleWorkspace: boolean;
}

/**
 * Decide the KB scope for a campaign-authoring draft. See the contracts above.
 */
export function resolveCampaignKbScope(args: CampaignKbScopeArgs): CampaignKbScope {
  if (!args.hasSearchableQuery) {
    return { scope: "none", kbOwnerId: undefined, documentFilter: undefined, reason: "no_query" };
  }
  // campaign_doc requires BOTH a validated doc id AND its verified owner. The
  // resolver nulls them together, but requiring both here means a doc id can
  // never be scoped to without an owner that passed the workspace check.
  if (args.campaignKnowledgeDocId && args.campaignKbOwnerId) {
    return {
      scope: "campaign_doc",
      kbOwnerId: args.campaignKbOwnerId,
      documentFilter: args.campaignKnowledgeDocId,
    };
  }
  // No validated document → the authoring user's OWN workspace KB — but ONLY when
  // that KB is unambiguously a single workspace's. Multi-workspace authors fail
  // closed to no search (never a cross-workspace fallback).
  if (args.authorIsSingleWorkspace) {
    return {
      scope: "workspace_fallback",
      kbOwnerId: args.resolvedUserId,
      documentFilter: undefined,
    };
  }
  return {
    scope: "none",
    kbOwnerId: undefined,
    documentFilter: undefined,
    reason: "multi_workspace_author",
  };
}
