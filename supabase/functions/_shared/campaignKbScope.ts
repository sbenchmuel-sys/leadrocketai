// ============================================================================
// CAMPAIGN-AUTHORING KB SCOPE DECISION (Unit A — no-file workspace fallback)
//
// Pure, dependency-free decision for how ai_task's campaign-authoring branch
// scopes knowledge-base retrieval. Extracted so the three-way branch can be
// unit-tested without standing up the whole ai_task serve() handler.
//
// FAIL-CLOSED CONTRACT (load-bearing — workspace isolation):
//   resolveCampaignAuthoringInstruction() only ever returns a non-null
//   knowledgeDocumentId together with a workspace-verified knowledgeDocOwnerId;
//   when the stored document id is foreign / owned by a non-member, BOTH are
//   nulled together. This helper additionally requires BOTH to be present before
//   it will scope to a document (defense in depth), so a document id can never be
//   used without its validated owner. When there is no validated document we fall
//   back to the AUTHORING USER'S OWN workspace KB (resolvedUserId) with no
//   document filter — never an unvalidated foreign owner, never a foreign doc id.
// ============================================================================

export type CampaignKbScope =
  | { scope: "campaign_doc"; kbOwnerId: string; documentFilter: string }
  | { scope: "workspace_fallback"; kbOwnerId: string; documentFilter: undefined }
  | { scope: "none"; kbOwnerId: undefined; documentFilter: undefined };

export interface CampaignKbScopeArgs {
  /** Whether there is a non-empty, long-enough query to embed (length gate already applied). */
  hasSearchableQuery: boolean;
  /** Validated campaign document id, or null when none/foreign (resolver fails closed). */
  campaignKnowledgeDocId: string | null;
  /** Workspace-verified owner of that document, or null when none/foreign. */
  campaignKbOwnerId: string | null;
  /** The authoring user — the only safe fallback KB owner. */
  resolvedUserId: string;
}

/**
 * Decide the KB scope for a campaign-authoring draft. See the fail-closed
 * contract above.
 */
export function resolveCampaignKbScope(args: CampaignKbScopeArgs): CampaignKbScope {
  if (!args.hasSearchableQuery) {
    return { scope: "none", kbOwnerId: undefined, documentFilter: undefined };
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
  // No validated document → the authoring user's OWN workspace KB, unscoped doc.
  return {
    scope: "workspace_fallback",
    kbOwnerId: args.resolvedUserId,
    documentFilter: undefined,
  };
}
