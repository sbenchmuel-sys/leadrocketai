// Single-source guards (SKELETON). Each rule pins one piece of logic to exactly
// one module so it cannot be re-duplicated after the master-upgrade units land.
// Every rule is `.skip`-ed today because the canonical module does not exist
// yet; the unit named in each comment flips `it.skip` → `it` when it ships.
//
// Style: source-text scan, same as coldAutoSendGate.test.ts. No imports of
// runtime code, so this file never pulls Deno modules into vitest.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

/** All .ts/.tsx files under `dir` (relative to repo root), recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.posix.join(dir, name);
    if (name === "node_modules" || name === "__evals__") continue;
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Files under `dirs` whose source matches `re`, excluding `allowed`. */
function offenders(dirs: string[], re: RegExp, allowed: (rel: string) => boolean): string[] {
  return dirs.flatMap(walk).filter((rel) => !allowed(rel) && re.test(src(rel)));
}

describe("single-source guards (enable per unit)", () => {
  // [E-S1a] — live: every edge function calls the Lovable gateway through
  // _shared/aiGateway.ts.
  it('"lovable.dev" appears only in _shared/aiGateway.ts [E-S1a]', () => {
    const bad = offenders(
      ["supabase/functions"],
      /lovable\.dev/,
      (rel) => rel === "supabase/functions/_shared/aiGateway.ts",
    );
    expect(bad).toEqual([]);
  });

  // [G-B] — enabled when the three htmlToPlainText copies (outlook-send,
  // outlook-webhook/processor, _shared/syncEngine) collapse into
  // _shared/textUtils.ts.
  it.skip('"function htmlToPlainText" is defined only in _shared/textUtils.ts [G-B]', () => {
    const bad = offenders(
      ["supabase/functions", "src"],
      /function htmlToPlainText\b/,
      (rel) => rel === "supabase/functions/_shared/textUtils.ts",
    );
    expect(bad).toEqual([]);
  });

  // [G-B] — enabled when _shared/dedupeKeys.ts owns every dedupe-key shape.
  // Today keys are built inline as template literals, e.g. `sms:inbound:${sid}`
  // in sms-webhook and `meeting_transcript:${id}` in meet-transcript-fetch.
  it.skip("dedupe-key template literals live only in _shared/dedupeKeys.ts [G-B]", () => {
    const bad = offenders(
      ["supabase/functions"],
      /dedupe_?[Kk]ey\s*[:=]\s*`[^`]*\$\{/,
      (rel) => rel === "supabase/functions/_shared/dedupeKeys.ts",
    );
    expect(bad).toEqual([]);
  });

  // [E-S1b] — enabled when ReplyComposer.tsx (and any other direct caller) sends
  // through src/lib/mailProviders/ instead of invoking the sender functions.
  it.skip('invoke("gmail-send" | "outlook-send") only under src/lib/mailProviders/ [E-S1b]', () => {
    const bad = offenders(
      ["src"],
      /invoke\(\s*["'](?:gmail-send|outlook-send)["']/,
      (rel) => rel.startsWith("src/lib/mailProviders/"),
    );
    expect(bad).toEqual([]);
  });

  // Keeps the file from being an all-skipped suite (vitest reports those as
  // "no tests"), and proves the scanner itself works on a rule that holds today.
  it("scanner smoke: _shared/signoff.ts is the only definition of stripAISignOff", () => {
    const bad = offenders(
      ["supabase/functions", "src"],
      /function stripAISignOff\b/,
      (rel) => rel === "supabase/functions/_shared/signoff.ts",
    );
    expect(bad).toEqual([]);
  });
});
