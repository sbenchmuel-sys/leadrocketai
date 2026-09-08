// Single-source guard for the shared AI gateway (Unit E-S1a).
//
// The Lovable AI gateway URL, auth header, timeout, retry and usage log line
// live in supabase/functions/_shared/aiGateway.ts and nowhere else. Any new
// edge-function code that talks to the gateway directly (a stray
// `fetch("https://ai.gateway.lovable.dev/...")`) fails this test.
//
// Mirrors the `.skip`-ed rule `"lovable.dev" only in _shared/aiGateway.ts` in
// the harness branch's singleSourceGuards.test.ts; once that lands this file
// can be folded into it.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const FUNCTIONS_ROOT = path.resolve(__dirname, "../../supabase/functions");
const ALLOWED = new Set(["_shared/aiGateway.ts"]);

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (/\.(ts|js|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("AI gateway single source", () => {
  it('"lovable.dev" appears in no file under supabase/functions/ except _shared/aiGateway.ts', () => {
    const offenders = collect(FUNCTIONS_ROOT)
      .filter((f) => !ALLOWED.has(path.relative(FUNCTIONS_ROOT, f).split(path.sep).join("/")))
      .filter((f) => readFileSync(f, "utf8").includes("lovable.dev"))
      .map((f) => path.relative(FUNCTIONS_ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("the gateway module is pure (no Deno.*, no createClient, no import.meta.env)", () => {
    const src = readFileSync(path.join(FUNCTIONS_ROOT, "_shared/aiGateway.ts"), "utf8");
    expect(src).not.toMatch(/\bDeno\./);
    expect(src).not.toMatch(/createClient/);
    expect(src).not.toMatch(/import\.meta\.env/);
  });

  it("whatsapp-events-processor: the WHATSAPP_AUTO_REPLY_ENABLED off-switch precedes the only auto-send", () => {
    const src = readFileSync(path.join(FUNCTIONS_ROOT, "whatsapp-events-processor/index.ts"), "utf8");
    const gate = src.indexOf('Deno.env.get("WHATSAPP_AUTO_REPLY_ENABLED") !== "true"');
    const send = src.indexOf("svc.sendMessage(");
    expect(gate).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(send);
    expect(src.indexOf("svc.sendMessage(", send + 1)).toBe(-1); // exactly one send site
    // The gate must `return` before the send, not merely log.
    const between = src.slice(gate, send);
    expect(between).toMatch(/auto-reply disabled by default \(WHATSAPP_AUTO_REPLY_ENABLED unset\)/);
    expect(between).toMatch(/\breturn;/);
  });
});
