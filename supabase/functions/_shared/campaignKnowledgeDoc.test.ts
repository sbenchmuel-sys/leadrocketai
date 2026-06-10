// Run: deno test supabase/functions/_shared/campaignKnowledgeDoc.test.ts
//
// Covers the shared, fail-closed campaign-KB validation used by BOTH the
// authoring path and the live send path, plus the live-send service-role trust
// gate. Workspace isolation is load-bearing: a document whose owner is not a
// member of the campaign's workspace must NEVER be scoped to, and an untrusted
// caller must NEVER be able to supply a KB owner.
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  isWorkspaceMember,
  validateCampaignKnowledgeDoc,
  resolveLiveSendCampaignKbScope,
} from "./campaignKnowledgeDoc.ts";

const WS = "workspace-A";
const OWNER = "owner-in-workspace-A";
const FOREIGN = "owner-in-workspace-B";
const DOC = "campaign-doc-1";

// Minimal chainable mock of the supabase-js query builder used by the helper.
// deno-lint-ignore no-explicit-any
function makeClient(opts: {
  docOwner?: string | null; // owner_user_id row for kb_chunks; undefined → no row
  members?: Array<[string, string]>; // [workspaceId, userId] membership pairs
  kbError?: boolean;
  memberError?: boolean;
}): any {
  const memberSet = new Set((opts.members ?? []).map(([w, u]) => `${w}::${u}`));
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        limit: () => builder,
        maybeSingle: () => {
          if (table === "kb_chunks") {
            if (opts.kbError) return Promise.resolve({ data: null, error: { message: "boom" } });
            if (opts.docOwner === undefined) return Promise.resolve({ data: null, error: null });
            return Promise.resolve({ data: { owner_user_id: opts.docOwner }, error: null });
          }
          if (table === "workspace_members") {
            if (opts.memberError) return Promise.resolve({ data: null, error: { message: "boom" } });
            const key = `${filters["workspace_id"]}::${filters["user_id"]}`;
            return Promise.resolve({
              data: memberSet.has(key) ? { user_id: filters["user_id"] } : null,
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
      return builder;
    },
  };
}

// ── validateCampaignKnowledgeDoc ────────────────────────────────────────────

Deno.test("validate: member-owned doc → returns {documentId, ownerId}", async () => {
  const client = makeClient({ docOwner: OWNER, members: [[WS, OWNER]] });
  const out = await validateCampaignKnowledgeDoc(client, WS, DOC);
  assertEquals(out, { documentId: DOC, ownerId: OWNER });
});

Deno.test("ISOLATION: doc owned by a NON-member → null (fail closed, no cross-workspace KB)", async () => {
  const client = makeClient({ docOwner: FOREIGN, members: [] }); // FOREIGN not a member of WS
  const out = await validateCampaignKnowledgeDoc(client, WS, DOC);
  assertEquals(out, null);
});

Deno.test("validate: no document id → null (no query needed)", async () => {
  const client = makeClient({ docOwner: OWNER, members: [[WS, OWNER]] });
  assertEquals(await validateCampaignKnowledgeDoc(client, WS, null), null);
  assertEquals(await validateCampaignKnowledgeDoc(client, WS, undefined), null);
});

Deno.test("validate: no workspace id → null", async () => {
  const client = makeClient({ docOwner: OWNER, members: [[WS, OWNER]] });
  assertEquals(await validateCampaignKnowledgeDoc(client, null, DOC), null);
});

Deno.test("validate: document has no chunks (owner row missing) → null", async () => {
  const client = makeClient({ docOwner: undefined, members: [[WS, OWNER]] });
  assertEquals(await validateCampaignKnowledgeDoc(client, WS, DOC), null);
});

Deno.test("validate: kb_chunks lookup errors → null (fail closed)", async () => {
  const client = makeClient({ kbError: true });
  assertEquals(await validateCampaignKnowledgeDoc(client, WS, DOC), null);
});

Deno.test("validate: membership check errors → null (fail closed)", async () => {
  const client = makeClient({ docOwner: OWNER, memberError: true });
  assertEquals(await validateCampaignKnowledgeDoc(client, WS, DOC), null);
});

// ── isWorkspaceMember ───────────────────────────────────────────────────────

Deno.test("member: service-role is trusted infra → true (no query)", async () => {
  const client = makeClient({});
  assertEquals(await isWorkspaceMember(client, WS, "service-role"), true);
});

Deno.test("member: real member → true; non-member → false; error → false", async () => {
  assertEquals(await isWorkspaceMember(makeClient({ members: [[WS, OWNER]] }), WS, OWNER), true);
  assertEquals(await isWorkspaceMember(makeClient({ members: [] }), WS, FOREIGN), false);
  assertEquals(await isWorkspaceMember(makeClient({ memberError: true }), WS, OWNER), false);
});

// ── resolveLiveSendCampaignKbScope (service-role trust gate) ─────────────────

Deno.test("live-scope: service-role + doc + owner → scope to that doc/owner", () => {
  const scope = resolveLiveSendCampaignKbScope({
    isServiceRole: true,
    campaignKnowledgeDocId: DOC,
    campaignKbOwnerId: OWNER,
  });
  assertEquals(scope, { documentFilter: DOC, ownerId: OWNER });
});

Deno.test("ISOLATION: NON-service-role caller can never scope to a campaign doc (even with doc+owner)", () => {
  const scope = resolveLiveSendCampaignKbScope({
    isServiceRole: false,
    campaignKnowledgeDocId: DOC,
    campaignKbOwnerId: OWNER,
  });
  assertEquals(scope, null);
});

Deno.test("live-scope: service-role but missing doc OR owner → null (fail closed to standard retrieval)", () => {
  assertEquals(
    resolveLiveSendCampaignKbScope({ isServiceRole: true, campaignKnowledgeDocId: DOC, campaignKbOwnerId: undefined }),
    null,
  );
  assertEquals(
    resolveLiveSendCampaignKbScope({ isServiceRole: true, campaignKnowledgeDocId: undefined, campaignKbOwnerId: OWNER }),
    null,
  );
  assertEquals(
    resolveLiveSendCampaignKbScope({ isServiceRole: true, campaignKnowledgeDocId: undefined, campaignKbOwnerId: undefined }),
    null,
  );
});
