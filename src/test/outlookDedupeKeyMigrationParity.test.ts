// Unit G-B — the backfill must land on a shape the helper can emit.
//
// WHY THIS FILE EXISTS, specifically
//
// The migration rewrote legacy Outlook keys onto the new lead-scoped shape by
// prefixing the lead id. For `outlook:<Message-ID>` that is right. For
// `outlook:<graph id>` it produced `outlook:<lead>:<graph id>` — and
// `outlookEmailDedupeKey` never emits that, because with no internetMessageId it
// emits `outlook:<lead>:graph:<id>`. A migrated row was therefore invisible to
// the helper forever and the next sync re-imported the message: the duplicate
// this unit exists to remove, reintroduced by its own backfill.
//
// The SQL test did not catch it. It is a real test, against real Postgres,
// running the real migration — and it asserted the wrong literal, because I
// wrote the expected key by hand instead of deriving it. So:
//
//   EVERY expectation here is COMPUTED BY THE REAL HELPER. Nothing is a
//   hand-written key. A shape the helper cannot produce cannot be asserted.
//
// This is source-text on the migration (it reads the .sql), but the values it
// compares against are behavioural — they come from calling the function the
// production code calls. Change the helper's shape and this fails.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { outlookEmailDedupeKey } from "../../supabase/functions/_shared/dedupeKeys.ts";

const ROOT = path.resolve(__dirname, "../..");
const MIGRATION = "supabase/migrations/20260914120000_unify_outlook_dedupe_keys.sql";
const sql = readFileSync(path.join(ROOT, MIGRATION), "utf8");
// Only the executable half — the header prose legitimately quotes old shapes.
const body = sql.slice(sql.indexOf("BEGIN;"));

const LEAD = "11111111-1111-1111-1111-111111111111";
const MSG_ID = "<AAB1C2D3@acme.com>";
const GRAPH_ID = "AAMkADkzNzFlNzAz=";

/**
 * The part of a key after `outlook:<leadId>:` — the shape the migration has to
 * reproduce. Derived, never typed out.
 */
function suffixOf(key: string): string {
  const prefix = `outlook:${LEAD}:`;
  expect(key.startsWith(prefix), `helper emitted an unexpected prefix: ${key}`).toBe(true);
  return key.slice(prefix.length);
}

describe("the backfill reproduces the helper's shapes", () => {
  const messageIdKey = outlookEmailDedupeKey(LEAD, MSG_ID, GRAPH_ID, "x");
  const graphKey = outlookEmailDedupeKey(LEAD, null, GRAPH_ID, "x");
  const interactionKey = outlookEmailDedupeKey(LEAD, null, null, "interaction-uuid");

  it("a Message-ID key carries NO namespace after the lead scope", () => {
    // Derived: whatever the helper does, the suffix must be the raw id.
    expect(suffixOf(messageIdKey)).toBe(MSG_ID);
  });

  it("a graph-fallback key IS namespaced after the lead scope", () => {
    expect(suffixOf(graphKey)).toBe(`graph:${GRAPH_ID}`);
  });

  it("the migration emits the graph namespace the helper uses", () => {
    // The namespace the helper actually produces, extracted from its output —
    // not the string "graph:" typed in by hand.
    const namespace = suffixOf(graphKey).slice(0, -GRAPH_ID.length);
    expect(namespace.length).toBeGreaterThan(0);
    expect(body).toContain(`'${namespace}'`);
  });

  it("the migration classifies legacy keys, rather than prefixing both alike", () => {
    // The defect was a single unconditional concat. There must be a branch.
    expect(body).toMatch(/CASE\s+WHEN[\s\S]{0,200}?LIKE\s*'<%@%>'/i);
    // ...and it must be applied to BOTH tables.
    const branches = [...body.matchAll(/CASE\s+WHEN\s+substring\(/gi)];
    expect(branches).toHaveLength(2);
  });

  it("the migration never writes the legacy unscoped prefix", () => {
    // `'outlook:' || <lead> || ':'` is the only way it may start a key.
    for (const m of body.matchAll(/'outlook:'\s*\|\|\s*([A-Za-z_.]+)/g)) {
      expect(m[1]).toMatch(/lead_id/);
    }
  });

  it("the interaction fallback is left alone, and the migration says so", () => {
    // The helper can emit it, and it is already unique, so it is excluded.
    expect(suffixOf(interactionKey)).toBe("interaction:interaction-uuid");
    const namespace = suffixOf(interactionKey).split(":")[0];
    expect(body).toContain(`NOT LIKE 'outlook:${namespace}:%'`);
  });
});

describe("the SQL test's expectations match the helper too", () => {
  // The SQL test cannot import TypeScript, so its expected keys are literals.
  // This pins those literals against the real helper — which is the check that
  // was missing when it asserted a shape the helper cannot emit.
  const sqlTest = readFileSync(
    path.join(ROOT, "supabase/tests/outlook_dedupe_key_scope.test.sql"),
    "utf8",
  );
  const SQL_LEAD = "00000000-0000-0000-0000-00000000f201";
  const SQL_MSG_ID = "<legacy@example.com>";
  const SQL_GRAPH_ID = "AAMkGRAPHID";

  it("the Message-ID expectation it asserts is one the helper emits", () => {
    expect(sqlTest).toContain(outlookEmailDedupeKey(SQL_LEAD, SQL_MSG_ID, null, "x"));
  });

  it("the graph-fallback expectation it asserts is one the helper emits", () => {
    expect(sqlTest).toContain(outlookEmailDedupeKey(SQL_LEAD, null, SQL_GRAPH_ID, "x"));
  });

  it("it does not assert the pre-fix shape", () => {
    // The literal the old test pinned: lead-scoped but missing the namespace.
    expect(sqlTest).not.toContain(`outlook:${SQL_LEAD}:${SQL_GRAPH_ID}'`);
  });
});
