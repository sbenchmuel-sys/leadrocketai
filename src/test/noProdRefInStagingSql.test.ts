// Static guard: nothing meant for staging may carry the PRODUCTION project ref.
//
// supabase/config.toml points at production, and the staging cron migration
// reads its URL/key from Vault precisely so the prod ref never appears in a
// file that gets applied to staging. Any file whose path contains "staging"
// (migrations, scripts, env examples, docs) must not mention the prod ref.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
// Split so this file (whose own path contains "Staging") doesn't trip itself.
const PROD_REF = ["ntzeiflqq", "luwgdfmatjh"].join("");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".vercel", ".lovable"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    if (SKIP_DIRS.has(name)) continue;
    const rel = dir ? path.posix.join(dir, name) : name;
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

describe("no production project ref in staging files", () => {
  const stagingFiles = walk("").filter((rel) => /staging/i.test(rel));

  it("finds staging-named files (guard is not vacuous)", () => {
    expect(stagingFiles.length).toBeGreaterThan(0);
  });

  for (const rel of stagingFiles) {
    it(`${rel} does not contain the production ref`, () => {
      const text = readFileSync(path.join(ROOT, rel), "utf8");
      expect(text.includes(PROD_REF)).toBe(false);
    });
  }
});
