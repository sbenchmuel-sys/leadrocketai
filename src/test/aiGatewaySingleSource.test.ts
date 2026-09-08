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

  it("whatsapp-events-processor: WHATSAPP_AUTO_REPLY_ENABLED is evaluated before the audit row and again before the only auto-send", () => {
    const src = readFileSync(path.join(FUNCTIONS_ROOT, "whatsapp-events-processor/index.ts"), "utf8");
    const policy = src.indexOf("const policyDecision = shouldAutoSend(");
    const flag = src.indexOf('Deno.env.get("WHATSAPP_AUTO_REPLY_ENABLED") === "true"');
    const auditRow = src.indexOf('from("automation_logs").insert(', policy);
    const gate = src.indexOf('Deno.env.get("WHATSAPP_AUTO_REPLY_ENABLED") !== "true"');
    const send = src.indexOf("svc.sendMessage(");
    for (const idx of [policy, flag, auditRow, gate, send]) expect(idx).toBeGreaterThan(-1);
    // Switch is folded into the decision BEFORE automation_logs is written …
    expect(policy).toBeLessThan(flag);
    expect(flag).toBeLessThan(auditRow);
    expect(src.slice(flag, auditRow)).toMatch(/allowed: false, reason: "auto-reply disabled \(WHATSAPP_AUTO_REPLY_ENABLED unset\)"/);
    // … and the audit row derives from that folded decision, not the raw policy.
    expect(src.slice(auditRow, auditRow + 300)).toMatch(/decision\.allowed \? "auto_sent" : "blocked"/);
    // Belt and braces: a second check returns right before the single send site.
    expect(auditRow).toBeLessThan(gate);
    expect(gate).toBeLessThan(send);
    expect(src.indexOf("svc.sendMessage(", send + 1)).toBe(-1);
    expect(src.slice(gate, send)).toMatch(/\breturn;/);
  });
});
