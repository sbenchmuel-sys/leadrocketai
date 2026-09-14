// SOURCE-TEXT guard (Unit G-B, finding 2). This is NOT behavioural coverage —
// it scans file text. The behavioural coverage for the key itself lives in
// supabase/functions/_shared/outlookDedupeKey.test.ts (Deno).
//
// What it pins: both Outlook writers must derive their dedupe key from the ONE
// helper. The bug it guards against is exactly what shipped — outlook-webhook
// hand-built `outlook:webhook:${graphId}` while outlook-sync used the helper's
// `outlook:<internetMessageId>`, so the same email was stored twice.
//
// timelineProjector.ts cannot be imported from src/ (it carries an esm.sh type
// import that src/test/sharedPurity.test.ts forbids), which is why this half of
// the check is source-text rather than a real call.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const WRITERS = [
  "supabase/functions/outlook-sync/index.ts",
  "supabase/functions/outlook-webhook/processor.ts",
];

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("Outlook dedupe keys come from one helper", () => {
  for (const rel of WRITERS) {
    const code = stripComments(readFileSync(path.join(ROOT, rel), "utf8"));

    it(`${rel} calls outlookEmailDedupeKey`, () => {
      expect(code).toMatch(/outlookEmailDedupeKey\s*\(/);
    });

    it(`${rel} does not hand-build an "outlook:" dedupe key`, () => {
      // Any template/string literal starting a key with `outlook:` is a
      // second source of truth. The helper is the only allowed producer.
      expect(code).not.toMatch(/["'`]outlook:/);
    });
  }

  it("the helper still lives where the writers import it from", () => {
    const projector = readFileSync(
      path.join(ROOT, "supabase/functions/_shared/timelineProjector.ts"),
      "utf8",
    );
    expect(projector).toMatch(/export function outlookEmailDedupeKey\s*\(/);
  });
});
