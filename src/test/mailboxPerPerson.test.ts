// Static guard (same pattern as coldAutoSendGate.test.ts): in a shared workspace —
// a client admin and a pilot rep, each with their own Outlook — every send path must
// pick the SENDER'S OWN mailbox, never the workspace default (a teammate's).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("each person sends from their own mailbox", () => {
  it("the app's send hook filters mail_accounts by the signed-in user", () => {
    const src = read("src/hooks/useMailSync.ts");
    const queries = src.split('.from("mail_accounts")').slice(1).filter((q) => q.includes(".select("));
    expect(queries.length).toBeGreaterThanOrEqual(2);
    for (const q of queries) expect(q.slice(0, 300)).toContain('.eq("user_id", user.id)');
  });

  it("the legacy automatic sender picks the lead owner's mailbox in the lead's workspace", () => {
    const src = read("supabase/functions/automation-executor/index.ts");
    const legacy = src.slice(src.indexOf("The lead OWNER's own mailbox in the LEAD's workspace"));
    const query = legacy.slice(0, legacy.indexOf(".maybeSingle()"));
    expect(query).toContain('.eq("workspace_id", lead.workspace_id)');
    expect(query).toContain('.eq("user_id", lead.owner_user_id)');
    expect(src).not.toMatch(/from\("workspace_members"\)\s*\.select\("workspace_id"\)\s*\.eq\("user_id", lead\.owner_user_id\)\s*\.limit\(1\)/);
  });

  it("outlook-send refuses a signed-in user sending from someone else's mailbox", () => {
    const src = read("supabase/functions/outlook-send/index.ts");
    expect(src).toMatch(/!isInternal && accountData\.user_id && accountData\.user_id !== userId/);
  });
});
