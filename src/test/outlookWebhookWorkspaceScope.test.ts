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

// ───────────────────────────────────────────────────────────────────────────
// SOURCE-TEXT guard (Unit G-B P1 — duplicate leads). Also not behavioural: the
// tiebreak itself is covered behaviourally by src/test/leadResolution.test.ts,
// but "the guardrail is applied to EVERY matching row, not just the attributed
// one" is a property of the call sites, and those sit inside a module-private
// function that builds its own client.
//
// THE BUG: attribution AND the instant-pause both went to the oldest duplicate,
// so an armed newer row kept emailing a customer who had just replied.
// ───────────────────────────────────────────────────────────────────────────
describe("outlook-webhook guardrails reach every duplicate lead row", () => {
  const code = stripComments(readFileSync(path.join(ROOT, FILE), "utf8"));

  it("attribution goes through the shared liveness rule, not an ad-hoc order", () => {
    expect(code).toMatch(/pickPrimaryLead\s*\(/);
    // The old tiebreak must be gone: no LEAD lookup may order by created_at.
    // (Scoped to `.from("leads")` statements — pauseActiveAutomation orders
    // automation_log rows by created_at, which is unrelated and correct.)
    for (const stmt of leadStatements(code)) {
      expect(stmt, `lead statement orders by created_at:\n${stmt}`)
        .not.toMatch(/\.order\(\s*["']created_at["']/);
    }
  });

  it("the reply pause is applied to every matched row, not just the primary", () => {
    // `pauseActiveAutomation` must never be called with the primary row's id —
    // every call site iterates the full match set.
    const pauseCalls = [...code.matchAll(/pauseActiveAutomation\(\s*\n?\s*serviceClient,\s*\n?\s*([A-Za-z0-9_.]+)/g)]
      .map((m) => m[1]);
    expect(pauseCalls.length).toBeGreaterThan(0);
    for (const arg of pauseCalls) {
      expect(arg, `pauseActiveAutomation called with ${arg}`).not.toBe("leadRow.id");
    }
  });

  it("the opt-out stop is applied to every matched row", () => {
    // `.in("id", matches...)` rather than `.eq("id", leadRow.id)`.
    expect(code).toMatch(/unsubscribed:\s*true[\s\S]{0,400}?\.in\(\s*["']id["']\s*,\s*matches/);
  });

  it("the bounce stop iterates all matched rows", () => {
    expect(code).toMatch(/for \(const row of \(bounceLeads \?\? \[\]\)/);
  });
});
