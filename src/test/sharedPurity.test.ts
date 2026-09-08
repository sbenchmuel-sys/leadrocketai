// Purity guard for cross-runtime shared modules.
//
// Any supabase/functions/_shared/*.ts file that src/ imports (via a relative
// path today, via the @shared/* alias going forward) is loaded by BOTH Deno
// (edge functions) and Vite/vitest (browser + Node). It must therefore be pure:
// no `Deno.` global, no `esm.sh` URL imports, no `import.meta.env`. A violation
// breaks one side or the other at import time — usually the production bundle.
//
// Comments are stripped before scanning: two files legitimately *mention*
// "Deno." / "esm.sh" in prose (campaignStepConfig.ts, coldSendFloorRules.ts)
// while being pure in code.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const IMPORT_RE =
  /from\s+["'](?:(?:\.\.\/)+supabase\/functions\/_shared\/|@shared\/)([A-Za-z0-9_./-]+)["']/g;
const FORBIDDEN: Array<[string, RegExp]> = [
  ["Deno.", /\bDeno\./],
  ["esm.sh", /esm\.sh/],
  ["import.meta.env", /import\.meta\.env/],
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.posix.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** _shared modules imported from anywhere under src/ (tests included). */
function sharedModulesImportedFromSrc(): string[] {
  const found = new Set<string>();
  for (const rel of walk("src")) {
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1].replace(/\.ts$/, "");
      found.add(`supabase/functions/_shared/${spec}.ts`);
    }
  }
  return [...found].sort();
}

describe("_shared modules imported from src/ are runtime-pure", () => {
  const modules = sharedModulesImportedFromSrc();

  it("finds at least one shared import (guard is not vacuous)", () => {
    expect(modules.length).toBeGreaterThan(0);
  });

  for (const rel of modules) {
    it(`${rel} has no Deno./esm.sh/import.meta.env in code`, () => {
      const code = stripComments(readFileSync(path.join(ROOT, rel), "utf8"));
      for (const [label, re] of FORBIDDEN) {
        expect(re.test(code), `${rel} contains ${label}`).toBe(false);
      }
    });
  }
});
