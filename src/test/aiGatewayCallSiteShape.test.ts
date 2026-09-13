// Call-site shape guard for the shared AI gateway (Unit E-S1a).
//
// aiGatewayFetch posts to the OpenAI-compatible /v1/chat/completions endpoint.
// That endpoint takes `messages: [...]` (NOT the legacy /api/generate `prompt`)
// and answers with `choices[0].message.content` (NOT a top-level `content` /
// `text`). A call site that keeps a legacy half compiles, type-checks and
// deploys — and then fails on every single request, silently, for ever. That
// is exactly what happened to promote-winning-interactions (Sales Brain).
//
// This is a SOURCE-TEXT guard, not a behavioural one: the call sites are Deno
// edge functions that import esm.sh/Deno globals, so vitest cannot execute
// them. The gateway module's own behaviour is covered by
// src/test/aiGatewayBehaviour.test.ts; this file guards the callers.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const FUNCTIONS_ROOT = path.resolve(__dirname, "../../supabase/functions");
const SKIP = /(^|\/)(_shared\/aiGateway\.ts|.*\.test\.ts)$/;

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (/\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Text of the balanced (...) / {...} region starting at `open`. */
function balanced(src: string, open: number): string {
  const close = { "(": ")", "{": "}", "[": "]" }[src[open] as "(" | "{" | "["]!;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === src[open]) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** Second argument (the request body) of each aiGatewayFetch(...) call in `src`. */
function requestBodies(src: string): string[] {
  const out: string[] = [];
  for (let i = src.indexOf("aiGatewayFetch("); i !== -1; i = src.indexOf("aiGatewayFetch(", i + 1)) {
    const args = balanced(src, i + "aiGatewayFetch".length).slice(1, -1);
    // split on the top-level commas
    const parts: string[] = [];
    let depth = 0, start = 0;
    for (let j = 0; j < args.length; j++) {
      const c = args[j];
      if ("({[".includes(c)) depth++;
      else if (")}]".includes(c)) depth--;
      else if (c === "," && depth === 0) { parts.push(args.slice(start, j)); start = j + 1; }
    }
    parts.push(args.slice(start));
    if (parts[1]) out.push(parts[1].trim());
  }
  return out;
}

/** Does this body (following `const x = {…}` and `...spread` indirection) carry `messages`? */
function carriesMessages(body: string, src: string, seen = new Set<string>()): boolean {
  if (/\bmessages\s*:/.test(body)) return true;
  const ids = new Set<string>();
  const bare = body.match(/^[A-Za-z_$][\w$]*$/);
  if (bare) ids.add(bare[0]);
  for (const m of body.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) ids.add(m[1]);
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${id}\\b[^=]*=\\s*\\{`).exec(src);
    if (decl && carriesMessages(balanced(src, src.indexOf("{", decl.index + decl[0].length - 1)), src, seen)) return true;
  }
  return false;
}

const files = collect(FUNCTIONS_ROOT)
  .filter((f) => !SKIP.test(path.relative(FUNCTIONS_ROOT, f).split(path.sep).join("/")))
  .filter((f) => readFileSync(f, "utf8").includes("aiGatewayFetch("))
  .map((f) => ({ rel: path.relative(FUNCTIONS_ROOT, f).split(path.sep).join("/"), src: readFileSync(f, "utf8") }));

describe("AI gateway call-site shape", () => {
  it("finds the converted call sites", () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  it("every aiGatewayFetch body sends `messages` and no legacy `prompt`", () => {
    const offenders: string[] = [];
    for (const { rel, src } of files) {
      for (const body of requestBodies(src)) {
        if (/^\s*\{[\s\S]*(^|[{,\s])prompt\s*[,:]/m.test(body)) offenders.push(`${rel}: legacy \`prompt\` key`);
        else if (!carriesMessages(body, src)) offenders.push(`${rel}: body has no \`messages\``);
      }
    }
    expect(offenders).toEqual([]);
  });

  // SOURCE-TEXT guard. call-analyze's handler is a `Deno.serve` closure that
  // imports esm.sh, so vitest cannot drive it; the error CLASSIFICATION this
  // depends on is covered behaviourally in
  // supabase/functions/call-analyze/statusOnGatewayError.test.ts (Deno, CI).
  it("call-analyze: a thrown gateway error marks the analysis failed, never leaves it processing", () => {
    const src = readFileSync(path.join(FUNCTIONS_ROOT, "call-analyze/index.ts"), "utf8");
    const call = src.indexOf("await aiGatewayFetch(");
    expect(call).toBeGreaterThan(-1);
    expect(src.indexOf("await aiGatewayFetch(", call + 1), "more than one gateway call — guard covers only the first").toBe(-1);

    // The call sits inside a try whose catch is the very next block.
    const tryOpen = src.lastIndexOf("try {", call);
    expect(tryOpen).toBeGreaterThan(-1);
    const catchOpen = src.indexOf("} catch", call);
    expect(catchOpen).toBeGreaterThan(call);
    const catchBlock = balanced(src, src.indexOf("{", catchOpen + 2));

    // …and that catch lands the row in the same terminal state as every other
    // failure path here, before returning.
    expect(catchBlock).toMatch(/from\("call_analyses"\)\s*\.update\(\{\s*status:\s*"failed"\s*\}\)/);
    expect(catchBlock).toMatch(/\.eq\("id",\s*analysisId\)/);
    expect(catchBlock).toMatch(/return\s+respond\(/);
    expect(catchBlock).not.toMatch(/"processing"/);
    // The reason is classified, so an operator can tell a timeout from a 500.
    expect(catchBlock).toMatch(/AiGatewayError\s*\?\s*err\.kind\s*:\s*"exception"/);
  });

  it("call-analyze: a non-JSON 200 body cannot throw out of the retry loop", () => {
    const src = readFileSync(path.join(FUNCTIONS_ROOT, "call-analyze/index.ts"), "utf8");
    expect(src).toMatch(/await\s+aiResponse\.json\(\)\.catch\(\(\)\s*=>\s*null\)/);
  });

  it("every parsed gateway response is read via choices[0].message", () => {
    const offenders: string[] = [];
    for (const { rel, src } of files) {
      // Response variables: direct `x = await aiGatewayFetch(` plus names
      // destructured from an `await Promise.all([...aiGatewayFetch...])`.
      // A response variable is "a gateway response" only between the gateway
      // assignment and the next assignment to that same name — edge functions
      // reuse names like `resp` for other fetches in the same file.
      const assigned: { name: string; at: number; gateway: boolean }[] = [];
      for (const m of src.matchAll(/(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*await\s+(\w+)/g)) {
        assigned.push({ name: m[1], at: m.index!, gateway: m[2] === "aiGatewayFetch" });
      }
      for (const m of src.matchAll(/(?:const|let|var)\s*\[([^\]]+)\]\s*=\s*await\s+Promise\.all\(\s*\[/g)) {
        const block = balanced(src, src.indexOf("[", m.index! + m[0].length - 1));
        if (!block.includes("aiGatewayFetch(")) continue;
        for (const n of m[1].split(",")) assigned.push({ name: n.trim(), at: m.index!, gateway: true });
      }
      const respVars = new Set(assigned.filter((a) => a.gateway).map((a) => a.name));
      const isGatewayAt = (name: string, at: number) => {
        const prior = assigned.filter((a) => a.name === name && a.at < at).pop();
        return prior?.gateway === true;
      };
      for (const m of src.matchAll(/(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*await\s+([A-Za-z_$][\w$]*)\.json\(\)/g)) {
        if (!isGatewayAt(m[2], m.index!)) continue;
        const after = src.slice(m.index! + m[0].length);
        const first = new RegExp(`\\b${m[1]}\\s*\\??\\.\\s*([\\w$]+)`).exec(after);
        if (!first) offenders.push(`${rel}: parsed \`${m[1]}\` is never read`);
        else if (first[1] !== "choices") offenders.push(`${rel}: reads \`${m[1]}.${first[1]}\`, not \`choices\``);
      }
      expect(respVars.size, `${rel}: no gateway response variable found`).toBeGreaterThan(0);
    }
    expect(offenders).toEqual([]);
  });
});
