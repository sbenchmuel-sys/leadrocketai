// Run: deno test supabase/functions/_shared/campaignKbScope.test.ts
//
// Covers the three-way campaign-authoring KB scope decision and the load-bearing
// fail-closed (workspace-isolation) properties:
//   • a foreign / non-member document id must NEVER be scoped to, nor used as the owner;
//   • the doc-less fallback fires ONLY for single-workspace authors — multi-workspace
//     authors fail closed to no search, never a cross-workspace fallback.
// See the contracts in campaignKbScope.ts.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { resolveCampaignKbScope } from "./campaignKbScope.ts";

const REP = "rep-authoring-user-id";
const DOC = "campaign-doc-id";
const DOC_OWNER = "validated-doc-owner-id"; // a member of the campaign workspace
const FOREIGN_OWNER = "another-tenant-owner-id";

Deno.test("campaign_doc — validated doc + verified owner → scope to that doc and owner (single-workspace gate irrelevant)", () => {
  for (const single of [true, false]) {
    const scope = resolveCampaignKbScope({
      hasSearchableQuery: true,
      campaignKnowledgeDocId: DOC,
      campaignKbOwnerId: DOC_OWNER,
      resolvedUserId: REP,
      authorIsSingleWorkspace: single,
    });
    assertEquals(scope.scope, "campaign_doc");
    assertEquals(scope.documentFilter, DOC);
    assertEquals(scope.kbOwnerId, DOC_OWNER);
  }
});

Deno.test("workspace_fallback — no doc + single-workspace author → author's OWN workspace KB, no doc filter", () => {
  const scope = resolveCampaignKbScope({
    hasSearchableQuery: true,
    campaignKnowledgeDocId: null,
    campaignKbOwnerId: null,
    resolvedUserId: REP,
    authorIsSingleWorkspace: true,
  });
  assertEquals(scope.scope, "workspace_fallback");
  assertEquals(scope.kbOwnerId, REP); // fallback owner is the authoring rep — never anyone else
  assertEquals(scope.documentFilter, undefined); // never a foreign id
});

Deno.test("ISOLATION: no doc + MULTI-workspace author → fail closed to none, never a cross-workspace fallback", () => {
  const scope = resolveCampaignKbScope({
    hasSearchableQuery: true,
    campaignKnowledgeDocId: null,
    campaignKbOwnerId: null,
    resolvedUserId: REP,
    authorIsSingleWorkspace: false,
  });
  assertEquals(scope.scope, "none");
  assertEquals(scope.kbOwnerId, undefined);
  assertEquals(scope.documentFilter, undefined);
  if (scope.scope === "none") assertEquals(scope.reason, "multi_workspace_author");
});

Deno.test("none — no searchable query → no KB search regardless of workspace count", () => {
  const scope = resolveCampaignKbScope({
    hasSearchableQuery: false,
    campaignKnowledgeDocId: DOC,
    campaignKbOwnerId: DOC_OWNER,
    resolvedUserId: REP,
    authorIsSingleWorkspace: true,
  });
  assertEquals(scope.scope, "none");
  assertEquals(scope.kbOwnerId, undefined);
  assertEquals(scope.documentFilter, undefined);
  if (scope.scope === "none") assertEquals(scope.reason, "no_query");
});

Deno.test("FAIL-CLOSED: foreign/non-member doc (resolver nulls both) + single-workspace → fallback to rep, never foreign owner", () => {
  // resolveCampaignAuthoringInstruction nulls knowledgeDocumentId AND
  // knowledgeDocOwnerId together when the stored doc is owned by a non-member.
  const scope = resolveCampaignKbScope({
    hasSearchableQuery: true,
    campaignKnowledgeDocId: null,
    campaignKbOwnerId: null,
    resolvedUserId: REP,
    authorIsSingleWorkspace: true,
  });
  assertEquals(scope.scope, "workspace_fallback");
  assertEquals(scope.kbOwnerId, REP);
  assertEquals(scope.documentFilter, undefined);
});

Deno.test("FAIL-CLOSED (defense in depth): doc id present but owner null → fallback path, never scope to owner-less doc", () => {
  // Even if a future change leaked a doc id without a verified owner, the helper
  // must require BOTH before scoping — otherwise treat as no-doc (and here the
  // single-workspace author gets the safe fallback).
  const scope = resolveCampaignKbScope({
    hasSearchableQuery: true,
    campaignKnowledgeDocId: DOC,
    campaignKbOwnerId: null,
    resolvedUserId: REP,
    authorIsSingleWorkspace: true,
  });
  assertEquals(scope.scope, "workspace_fallback");
  assertEquals(scope.kbOwnerId, REP);
  assertEquals(scope.documentFilter, undefined);
});

Deno.test("FAIL-CLOSED: a bare foreign owner id is never selected as the KB owner", () => {
  // Sanity: regardless of inputs, the only owners this helper can return are the
  // validated doc owner (with its own doc) or the authoring rep — never a bare
  // foreign owner without its validated doc.
  const scope = resolveCampaignKbScope({
    hasSearchableQuery: true,
    campaignKnowledgeDocId: null,
    campaignKbOwnerId: FOREIGN_OWNER, // would only be set alongside a validated doc id
    resolvedUserId: REP,
    authorIsSingleWorkspace: true,
  });
  assertEquals(scope.scope, "workspace_fallback");
  assertEquals(scope.kbOwnerId, REP);
  assertEquals(scope.documentFilter, undefined);
});
