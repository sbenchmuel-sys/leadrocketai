// Boot guard. In Deno, importing a named export that doesn't exist is a
// link-time SyntaxError: the function never boots (503 BOOT_ERROR) and no test
// of callConfig.ts itself notices. PR #145 did exactly that to
// twilio-voice-webhook, call-ingest-recording and call-transcribe.
//
// This reads every edge function's `import { … } from "../_shared/callConfig.ts"`
// list and fails if callConfig.ts stops exporting any of those names.
// Deno suite: `npm run test:edge`.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as callConfig from "./callConfig.ts";

const FUNCTIONS_DIR = new URL("../", import.meta.url);
const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*["']\.\.\/_shared\/callConfig\.ts["']/g;

Deno.test("every name an edge function imports from callConfig.ts is exported", () => {
  const importers: string[] = [];
  const missing: string[] = [];

  for (const dir of Deno.readDirSync(FUNCTIONS_DIR)) {
    if (!dir.isDirectory || dir.name === "_shared") continue;
    let src: string;
    try {
      src = Deno.readTextFileSync(new URL(`${dir.name}/index.ts`, FUNCTIONS_DIR));
    } catch {
      continue; // folder without an index.ts
    }
    for (const match of src.matchAll(IMPORT_RE)) {
      importers.push(dir.name);
      for (const raw of match[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/)[0];
        // `type Foo` imports are erased at compile time — they can't break boot.
        if (!name || name.startsWith("type ")) continue;
        if (!(name in callConfig)) missing.push(`${dir.name} → ${name}`);
      }
    }
  }

  // If this drops to zero the regex has rotted and the guard is checking nothing.
  assert(importers.length >= 5, `expected ≥5 callConfig importers, found: ${importers.join(", ")}`);
  assertEquals(missing, [], "callConfig.ts no longer exports names that deployed functions import");
});
