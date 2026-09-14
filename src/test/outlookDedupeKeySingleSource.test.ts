// SOURCE-TEXT guard (Unit G-B). NOT behavioural coverage — it scans file text.
// The behavioural coverage for the key is src/test/outlookDedupeKey.test.ts
// (real function) and supabase/tests/outlook_dedupe_key_scope.test.sql (real
// Postgres unique index).
//
// What it pins: there is exactly ONE producer of Outlook dedupe keys, every
// call to it is lead-scoped, and no Outlook writer hand-builds a key.
//
// The two defects it guards against, both of which shipped:
//   • outlook-webhook wrote `outlook:webhook:<graphId>` while outlook-sync wrote
//     `outlook:<internetMessageId>` — the same email stored twice.
//   • unifying them on the Message-ID made the key GLOBAL, so two tenants
//     receiving the same message collided on `interactions`' unique index and
//     the second resolved to the first's interaction row.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const KEYS = "supabase/functions/_shared/dedupeKeys.ts";
/** Files that write an Outlook `dedupe_key`, or build one on their behalf. */
const OUTLOOK_KEY_FILES = [
  "supabase/functions/outlook-sync/index.ts",
  "supabase/functions/outlook-webhook/processor.ts",
  "supabase/functions/_shared/outlookCandidates.ts",
];

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const read = (rel: string) => stripComments(readFileSync(path.join(ROOT, rel), "utf8"));

describe("Outlook dedupe keys come from one lead-scoped helper", () => {
  it("the helper exists, and takes the lead id first", () => {
    expect(read(KEYS)).toMatch(/export function outlookEmailDedupeKey\(\s*leadId: string/);
  });

  for (const rel of OUTLOOK_KEY_FILES) {
    it(`${rel} does not hand-build an "outlook:" key`, () => {
      // Any literal starting a key with `outlook:` is a second source of truth.
      // dedupeKeys.ts is the sole exception and is not in this list.
      expect(read(rel)).not.toMatch(/["'`]outlook:/);
    });
  }

  it("every call to the helper, anywhere, is lead-scoped", () => {
    // The first argument must be the lead. A call that starts with the message
    // id is the pre-scope signature and re-opens the cross-tenant collapse.
    let calls = 0;
    for (const rel of OUTLOOK_KEY_FILES) {
      for (const m of read(rel).matchAll(/outlookEmailDedupeKey\(\s*([^,)]+)/g)) {
        calls++;
        expect(m[1].trim(), `${rel}: first argument is not a lead id`).toMatch(/lead/i);
      }
    }
    expect(calls, "guard is vacuous — no calls found").toBeGreaterThan(0);
  });

  it("the old unscoped builder is gone from timelineProjector", () => {
    const projector = read("supabase/functions/_shared/timelineProjector.ts");
    expect(projector).not.toMatch(/export function outlookEmailDedupeKey/);
  });
});
