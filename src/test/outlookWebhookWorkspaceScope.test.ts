// SOURCE-TEXT guard (Unit G-B, finding 1 — cross-tenant leak). This is NOT
// behavioural coverage: it scans the file, it does not run the query. The
// behavioural proof has to be run against a database — see the staging check in
// the unit report ("two workspaces, one email address").
//
// Why a source-text guard is all that is possible here: the lookup is a
// PostgREST call inside `processChangeNotification`, which is module-private
// and builds its own service client from `Deno.env`. Making it injectable is a
// larger change than the fix itself.
//
// THE BUG: every lead lookup in the Outlook webhook was
//   .from("leads").select(...).eq("email", x)
// with no workspace filter. `leads.email` is not globally unique — measured on
// production 2026-09-14, 350 addresses exist as leads in more than one
// workspace — so an inbound message could be attached to, and stop the
// automation of, a lead belonging to a different tenant.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const FILE = "supabase/functions/outlook-webhook/processor.ts";

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** Each `.from("leads")` … up to the statement terminator. */
function leadStatements(code: string): string[] {
  return code
    .split('.from("leads")')
    .slice(1)
    .map((chunk) => chunk.split(";")[0]);
}

describe("outlook-webhook lead lookups are workspace-scoped", () => {
  const code = stripComments(readFileSync(path.join(ROOT, FILE), "utf8"));
  const statements = leadStatements(code);
  const reads = statements.filter((s) => s.includes(".select("));

  it("the guard is not vacuous — there are lead reads to check", () => {
    expect(reads.length).toBeGreaterThan(0);
  });

  it("every lead READ filters on workspace_id", () => {
    const unscoped = reads.filter((s) => !s.includes('.eq("workspace_id"'));
    expect(unscoped, `unscoped lead reads:\n${unscoped.join("\n---\n")}`).toEqual([]);
  });

  it("no lead read matches on email alone", () => {
    for (const s of reads) {
      if (s.includes('.eq("email"')) {
        expect(s).toContain('.eq("workspace_id", mailboxWorkspaceId)');
      }
    }
  });

  it("the handler fails closed when the mailbox has no workspace", () => {
    // The early return must exist, and must come before any lead lookup.
    const guardAt = code.indexOf("if (!mailboxWorkspaceId)");
    const firstRead = code.indexOf('.from("leads")');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(firstRead);
  });
});
