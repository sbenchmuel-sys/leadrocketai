// Workspace / RLS isolation integration test (runs against the STAGING Supabase
// project only — see src/test/integration/setup.ts for the staging guard).
//
// Proves the core "data cannot leak across users / dealerships" guarantee:
// two reps in two different workspaces each own a lead, and NEITHER can read
// the other's lead through the public (RLS-enforced) API.
//
// Credentials come from the gitignored .env.staging (TEST_USER_*). The fixture
// (workspaces, memberships, leads) is created with the service-role key, which
// bypasses RLS — then the actual assertions run as the REAL signed-in users, so
// RLS is genuinely exercised.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL!;
const ANON = process.env.SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const A = {
  email: process.env.TEST_USER_A_EMAIL!,
  id: process.env.TEST_USER_A_ID!,
  pw: process.env.TEST_USER_PASSWORD!,
};
const B = {
  email: process.env.TEST_USER_B_EMAIL!,
  id: process.env.TEST_USER_B_ID!,
  pw: process.env.TEST_USER_PASSWORD!,
};

const WS_NAME_A = "Isolation Test — Dealership A";
const WS_NAME_B = "Isolation Test — Dealership B";

// Captured fixture IDs (workspaces are created by the users themselves, so ids
// are server-generated — the real onboarding path, which also fires the
// auto_add_workspace_creator trigger that makes the creator an admin).
// IDs generated client-side so inserts don't need a read-back (return=representation),
// which would otherwise trip the workspaces SELECT policy at insert time.
const WS_A = crypto.randomUUID();
const WS_B = crypto.randomUUID();
const LEAD_A = crypto.randomUUID();
const LEAD_B = crypto.randomUUID();

const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
let clientA: SupabaseClient;
let clientB: SupabaseClient;

// Sign in, then return a data client wired to that user's JWT via the
// `accessToken` option — supabase-js uses it for every PostgREST request and
// does NOT override it, so RLS runs as that real user. (Global Authorization
// headers get clobbered by the client's own token logic; this is the reliable way.)
async function signIn(email: string, pw: string): Promise<SupabaseClient> {
  const authClient = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await authClient.auth.signInWithPassword({ email, password: pw });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  const token = data.session?.access_token;
  if (!token) throw new Error(`sign-in for ${email} returned no access token`);
  return createClient(URL, ANON, { accessToken: async () => token });
}

// Tear down ONLY this harness's fixtures, in FK-safe order. Uses the service
// role so it ignores RLS. Scope everything to the test WORKSPACES (resolved by
// their fixed, test-only names) rather than by owner_user_id — the test users
// may legitimately own other staging data, and a broad owner-scoped delete would
// wipe it (and several lead-related tables cascade from leads). Resolving by name
// also catches leftovers from a prior crashed run, whose random UUIDs differ.
async function cleanup() {
  const { data: ws } = await admin
    .from("workspaces")
    .select("id")
    .in("name", [WS_NAME_A, WS_NAME_B]);
  const wsIds = (ws ?? []).map((w) => (w as { id: string }).id);
  if (wsIds.length > 0) {
    await admin.from("leads").delete().in("workspace_id", wsIds);
    await admin.from("workspace_members").delete().in("workspace_id", wsIds);
  }
  await admin.from("workspaces").delete().in("name", [WS_NAME_A, WS_NAME_B]);
}

// Insert without .select() — a chained read-back (return=representation) would
// re-evaluate the SELECT policy at insert time and 403 before the
// auto_add_workspace_creator trigger's membership is visible to it.
async function createWorkspace(c: SupabaseClient, id: string, name: string): Promise<void> {
  const { error } = await c.from("workspaces").insert({ id, name });
  if (error) throw new Error(`create workspace "${name}": ${error.message}`);
}

async function createLead(c: SupabaseClient, id: string, wsId: string, ownerId: string, tag: string): Promise<void> {
  const { error } = await c.from("leads").insert({
    id, workspace_id: wsId, owner_user_id: ownerId,
    company: `Acme ${tag}`, name: `Lead ${tag}`, email: `lead-${tag.toLowerCase()}@example.com`, strategy: "fast",
  });
  if (error) throw new Error(`create lead ${tag}: ${error.message}`);
}

beforeAll(async () => {
  await cleanup(); // remove any leftovers from a prior run

  clientA = await signIn(A.email, A.pw);
  clientB = await signIn(B.email, B.pw);

  // Each rep creates their OWN workspace (trigger makes them its admin) and one lead.
  await createWorkspace(clientA, WS_A, WS_NAME_A);
  await createWorkspace(clientB, WS_B, WS_NAME_B);
  await createLead(clientA, LEAD_A, WS_A, A.id, "A");
  await createLead(clientB, LEAD_B, WS_B, B.id, "B");
}, 60_000);

afterAll(async () => {
  await cleanup();
});

describe("workspace / RLS isolation (staging)", () => {
  it("each rep can read their OWN lead (positive control)", async () => {
    const a = await clientA.from("leads").select("id").eq("id", LEAD_A);
    expect(a.error).toBeNull();
    expect(a.data?.map((x) => x.id)).toEqual([LEAD_A]);

    const b = await clientB.from("leads").select("id").eq("id", LEAD_B);
    expect(b.error).toBeNull();
    expect(b.data?.map((x) => x.id)).toEqual([LEAD_B]);
  });

  it("Rep B CANNOT read Rep A's lead by id", async () => {
    const res = await clientB.from("leads").select("id").eq("id", LEAD_A);
    expect(res.error).toBeNull(); // RLS hides rows silently, not an error
    expect(res.data).toEqual([]);
  });

  it("Rep A CANNOT read Rep B's lead by id", async () => {
    const res = await clientA.from("leads").select("id").eq("id", LEAD_B);
    expect(res.error).toBeNull();
    expect(res.data).toEqual([]);
  });

  it("a full lead list never includes the other workspace's lead", async () => {
    const aAll = await clientA.from("leads").select("id");
    expect(aAll.error).toBeNull();
    expect(aAll.data?.map((x) => x.id)).not.toContain(LEAD_B);

    const bAll = await clientB.from("leads").select("id");
    expect(bAll.error).toBeNull();
    expect(bAll.data?.map((x) => x.id)).not.toContain(LEAD_A);
  });

  it("Rep B cannot see Rep A's workspace row", async () => {
    const res = await clientB.from("workspaces").select("id").eq("id", WS_A);
    expect(res.error).toBeNull();
    expect(res.data).toEqual([]);
  });
});
