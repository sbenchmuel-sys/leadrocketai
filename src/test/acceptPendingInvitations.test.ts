// Invitations must be accepted through the accept-workspace-invite edge function
// (server rights), for brand-new AND existing users. Before: the browser inserted
// the membership itself (refused by RLS) and only for users with no workspace, so
// not one invitation had ever been accepted.
import { describe, expect, it, vi, beforeEach } from "vitest";

let pending: { id: string; workspace_id: string }[] = [];
const invoked: unknown[] = [];
const inserts: unknown[] = [];
let invokeResult: { data: unknown; error: unknown } = { data: { ok: true }, error: null };

const chain: any = {
  select: () => chain, eq: () => chain,
  insert: (row: unknown) => { inserts.push(row); return Promise.resolve({ error: null }); },
  then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: pending, error: null }).then(ok),
};
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => chain,
    functions: { invoke: (name: string, opts: { body: unknown }) => { invoked.push({ name, ...opts }); return Promise.resolve(invokeResult); } },
  },
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({}) }));
const { acceptPendingInvitations } = await import("@/contexts/WorkspaceContext");

describe("acceptPendingInvitations", () => {
  beforeEach(() => { invoked.length = 0; inserts.length = 0; invokeResult = { data: { ok: true }, error: null }; });

  it("an existing user (already in other workspaces) joins the invited workspace via the server", async () => {
    pending = [{ id: "inv1", workspace_id: "paythings" }];
    const joined = await acceptPendingInvitations("Cliff@Paythings.com", ["sandbox-1", "sandbox-2"]);
    expect(joined).toEqual(["paythings"]);
    expect(invoked).toEqual([{ name: "accept-workspace-invite", body: { invitation_id: "inv1" } }]);
    expect(inserts).toHaveLength(0); // never from the browser — RLS refuses it
  });

  it("a failed accept leaves nothing joined (the invitation stays pending for the next load)", async () => {
    pending = [{ id: "inv1", workspace_id: "paythings" }];
    invokeResult = { data: null, error: new Error("network") };
    expect(await acceptPendingInvitations("rep@paythings.com", [])).toEqual([]);
  });

  it("does nothing without an email", async () => {
    pending = [{ id: "inv1", workspace_id: "paythings" }];
    expect(await acceptPendingInvitations(null, [])).toEqual([]);
    expect(invoked).toHaveLength(0);
  });
});
