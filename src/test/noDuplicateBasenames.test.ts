// Static guard: a module basename must not exist in BOTH src/lib/ and
// supabase/functions/_shared/. Two files with the same name on both sides of
// the runtime boundary drift silently (the draftValidator "mirror" is the
// canonical example) — new shared logic goes in _shared/ and is imported from
// src/ via the @shared/* alias instead of being copied.
//
// The four collisions that exist today are allowlisted so this passes now and
// fails on the FIFTH. Each allowlist entry is a de-duplication debt: remove the
// entry when the src/lib copy is deleted in favour of the @shared import.
import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const LIB = path.join(ROOT, "src/lib");
const SHARED = path.join(ROOT, "supabase/functions/_shared");

// Verified colliding on 2026-09-07 (comm -12 of the two listings).
const KNOWN_COLLISIONS = new Set([
  "draftValidator.ts",
  "mergeFieldInterpolate.ts",
  "campaignResolver.ts",
  "campaignTypes.ts",
]);

const files = (dir: string) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.tsx?$/.test(d.name))
    .map((d) => d.name);

describe("no duplicate basenames across src/lib and _shared", () => {
  const lib = new Set(files(LIB));
  const collisions = files(SHARED).filter((n) => lib.has(n)).sort();

  it("every collision is a known, allowlisted one", () => {
    const unexpected = collisions.filter((n) => !KNOWN_COLLISIONS.has(n));
    expect(unexpected, `new basename collision(s): ${unexpected.join(", ")}`).toEqual([]);
  });

  it("the allowlist only names files that still collide (prune it when a copy is removed)", () => {
    const stale = [...KNOWN_COLLISIONS].filter((n) => !collisions.includes(n));
    expect(stale, `allowlist entries that no longer collide: ${stale.join(", ")}`).toEqual([]);
  });
});
