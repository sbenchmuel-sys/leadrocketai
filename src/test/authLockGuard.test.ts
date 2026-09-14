// Guard for the BUG-014 root-cause fix (src/integrations/supabase/authLock.ts).
//
// client.ts is a Lovable-generated file and gets rewritten now and then; if the
// `auth.lock` / `auth.fetch` options drop out, the multi-tab spinner hang comes
// straight back with no error anywhere. This fails `npm test` the day that happens.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { boundedAuthLock, authFetchWithTimeout, AUTH_LOCK_TIMEOUT_MS } from "@/integrations/supabase/authLock";

describe("supabase client keeps the bounded auth lock", () => {
  it("client.ts wires boundedAuthLock + authFetchWithTimeout into auth options", () => {
    const src = readFileSync(path.resolve(__dirname, "../integrations/supabase/client.ts"), "utf8");
    expect(src).toMatch(/lock:\s*boundedAuthLock/);
    expect(src).toMatch(/global:\s*\{\s*fetch:\s*authFetchWithTimeout/);
  });

  it("a 'wait forever' acquire becomes a bounded wait (no navigator.locks here → runs inline)", async () => {
    // jsdom has no navigator.locks, so supabase's navigatorLock runs fn() directly.
    // The point of this check: the -1 path resolves instead of hanging.
    const result = await Promise.race([
      boundedAuthLock("lock:test", -1, async () => "ran"),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("hung")), AUTH_LOCK_TIMEOUT_MS + 1000)),
    ]);
    expect(result).toBe("ran");
  });
});

describe("authFetchWithTimeout", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("puts a deadline on /auth/v1/* requests only", async () => {
    const calls: { url: string; hasSignal: boolean }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), hasSignal: !!init?.signal });
      return new Response("{}");
    }));
    await authFetchWithTimeout("https://x.supabase.co/auth/v1/token?grant_type=refresh_token", { method: "POST" });
    await authFetchWithTimeout("https://x.supabase.co/rest/v1/leads", { method: "GET" });
    await authFetchWithTimeout("https://x.supabase.co/functions/v1/ai_task", { method: "POST" });
    expect(calls.map((c) => c.hasSignal)).toEqual([true, false, false]);
  });
});
