import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";

// ponytail: execute the existing local refresh function without starting its Deno server.
const source = readFileSync("supabase/functions/detect-lead-candidates/index.ts", "utf8");
const start = source.indexOf("async function gmailRefreshToken(");
const end = source.indexOf("// ── Filter context loader", start);
if (start < 0 || end < 0) throw new Error("Missing Gmail refresh function");
const compiled = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function harness(status: number, body: object, failTable?: string) {
  const writes: { table: string; values: object; filters: [string, string][] }[] = [];
  const admin = {
    from(table: string) {
      return {
        update(values: object) {
          const write = { table, values, filters: [] as [string, string][] };
          writes.push(write);
          const query = {
            eq(column: string, value: string) { write.filters.push([column, value]); return query; },
            then(resolve: (value: object) => unknown) {
              return Promise.resolve({ error: table === failTable ? { message: "write failed" } : null }).then(resolve);
            },
          };
          return query;
        },
      };
    },
  };
  const refresh = new Function("Deno", "fetch", "safeDecryptToken", "encryptToken",
    `${compiled}; return gmailRefreshToken;`)(
    { env: { get: () => "test-only" } },
    async () => new Response(JSON.stringify(body), { status }),
    async () => "test-only",
    async () => "encrypted-test-token",
  );
  const conn = {
    user_id: "test-user", gmail_email: "rep@example.test",
    access_token_encrypted: "encrypted", refresh_token_encrypted: "encrypted",
    token_expires_at: "2020-01-01T00:00:00Z",
  };
  return { writes, run: () => refresh(admin, conn) };
}

describe("Gmail detection reconnect", () => {
  it("flags both stores only for the revoked user's Gmail mailbox and still rejects", async () => {
    const h = harness(400, { error: "invalid_grant" });
    await expect(h.run()).rejects.toThrow("Gmail token refresh failed (400)");
    expect(h.writes).toEqual([
      { table: "gmail_connections", values: { needs_reconnect: true }, filters: [["user_id", "test-user"]] },
      { table: "mail_accounts", values: { needs_reconnect: true, status: "expired", error_reason: "Gmail permission expired. Reconnect Gmail." },
        filters: [["provider", "gmail"], ["user_id", "test-user"], ["email_address", "rep@example.test"]] },
    ]);
  });
  it("does not disconnect a mailbox for a transient provider failure", async () => {
    const h = harness(503, { error: "temporarily_unavailable" });
    await expect(h.run()).rejects.toThrow("Gmail token refresh failed (503)");
    expect(h.writes).toEqual([]);
  });
  it("reports a failed reconnect flag rather than claiming it was saved", async () => {
    const h = harness(400, { error: "invalid_grant" }, "gmail_connections");
    await expect(h.run()).rejects.toThrow("Gmail reconnect flag failed: write failed");
    expect(h.writes).toHaveLength(2);
  });
  it("keeps successful refresh tokens encrypted", async () => {
    const h = harness(200, { access_token: "new-test-token", expires_in: 3600 });
    await expect(h.run()).resolves.toBe("new-test-token");
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].values).toMatchObject({ access_token_encrypted: "encrypted-test-token" });
  });
});