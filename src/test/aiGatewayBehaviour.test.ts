// Vitest mirror of supabase/functions/_shared/aiGateway.test.ts (the Deno suite
// cannot run in every sandbox). The gateway is a pure module, so it imports
// straight from the edge-function tree.
import { describe, expect, it } from "vitest";
import {
  AI_GATEWAY_TIMEOUT_MS,
  AI_GATEWAY_URL,
  AiGatewayError,
  aiGatewayFetch,
  isRetryableGatewayStatus,
} from "../../supabase/functions/_shared/aiGateway.ts";

interface Seen { url: string; init: RequestInit }

function fakeFetch(responses: Array<() => Response>, seen: Seen[]): typeof fetch {
  let i = 0;
  return ((url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Promise.resolve(responses[Math.min(i++, responses.length - 1)]());
  }) as unknown as typeof fetch;
}

const okJson = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { total_tokens: 7 } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const noSleep = () => Promise.resolve();

describe("aiGatewayFetch", () => {
  it("retries once on 429 then returns the successful response and logs one line", async () => {
    const seen: Seen[] = [];
    const logs: string[] = [];
    const res = await aiGatewayFetch("k", { model: "m" }, {
      fetchImpl: fakeFetch([() => new Response("slow down", { status: 429 }), okJson], seen),
      sleep: noSleep,
      log: (l) => logs.push(l),
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect((await res.json()).choices[0].message.content).toBe("hi");
    expect(logs).toHaveLength(1);
    const line = JSON.parse(logs[0]);
    expect(line).toMatchObject({ tag: "ai_gateway", model: "m", status: 200, attempts: 2, usage: { total_tokens: 7 } });
    expect(typeof line.ms).toBe("number");
  });

  it("does not retry on 400 or 402 (credits) and returns the response untouched", async () => {
    for (const status of [400, 402]) {
      const seen: Seen[] = [];
      const res = await aiGatewayFetch("k", { model: "m" }, {
        fetchImpl: fakeFetch([() => new Response("bad", { status })], seen),
        sleep: noSleep,
        log: () => {},
      });
      expect(res.status).toBe(status);
      expect(seen).toHaveLength(1);
      expect(await res.text()).toBe("bad");
    }
    expect(isRetryableGatewayStatus(402)).toBe(false);
  });

  it("retries exactly once on 5xx and returns the second failure as-is", async () => {
    for (const status of [500, 503]) {
      const seen: Seen[] = [];
      const res = await aiGatewayFetch("k", { model: "m" }, {
        fetchImpl: fakeFetch([() => new Response("x", { status })], seen),
        sleep: noSleep,
        log: () => {},
      });
      expect(res.status).toBe(status);
      expect(seen).toHaveLength(2);
    }
    expect(isRetryableGatewayStatus(429)).toBe(true);
    expect(isRetryableGatewayStatus(401)).toBe(false);
    expect(isRetryableGatewayStatus(200)).toBe(false);
  });

  it("timeout surfaces a typed AiGatewayError(kind=timeout)", async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const p = aiGatewayFetch("k", { model: "m" }, { fetchImpl: hanging, timeoutMs: 10, log: () => {} });
    await expect(p).rejects.toBeInstanceOf(AiGatewayError);
    await expect(p).rejects.toMatchObject({ kind: "timeout" });
  });

  it("per-call timeoutMs override is honoured (default is 90s)", async () => {
    expect(AI_GATEWAY_TIMEOUT_MS).toBe(90_000);
    const slow = ((_url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(okJson()), 40);
        init.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); });
      })) as unknown as typeof fetch;
    const ok = await aiGatewayFetch("k", { model: "m" }, { fetchImpl: slow, timeoutMs: 2_000, log: () => {} });
    expect(ok.status).toBe(200);
    await expect(aiGatewayFetch("k", { model: "m" }, { fetchImpl: slow, timeoutMs: 5, log: () => {} }))
      .rejects.toMatchObject({ kind: "timeout" });
  });

  it("network failure surfaces AiGatewayError(kind=network)", async () => {
    const failing = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    await expect(aiGatewayFetch("k", { model: "m" }, { fetchImpl: failing, log: () => {} }))
      .rejects.toMatchObject({ kind: "network" });
  });

  it("missing key surfaces AiGatewayError(kind=missing_key) without calling fetch", async () => {
    const seen: Seen[] = [];
    await expect(aiGatewayFetch(undefined, { model: "m" }, { fetchImpl: fakeFetch([okJson], seen), log: () => {} }))
      .rejects.toMatchObject({ kind: "missing_key" });
    await expect(aiGatewayFetch("", { model: "m" }, { fetchImpl: fakeFetch([okJson], seen), log: () => {} }))
      .rejects.toMatchObject({ kind: "missing_key" });
    expect(seen).toHaveLength(0);
  });

  it("sets bearer auth, JSON content type, the single URL and the serialised body", async () => {
    const seen: Seen[] = [];
    await aiGatewayFetch("secret-key", { model: "m", messages: [] }, { fetchImpl: fakeFetch([okJson], seen), log: () => {} });
    expect(seen[0].url).toBe(AI_GATEWAY_URL);
    expect(AI_GATEWAY_URL).toContain("lovable.dev");
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].init.body).toBe(JSON.stringify({ model: "m", messages: [] }));
  });

  it("streaming requests are returned without the body being consumed", async () => {
    const res = await aiGatewayFetch("k", { model: "m", stream: true }, {
      fetchImpl: fakeFetch([() => new Response("data: x\n\n", { status: 200 })], []),
      log: () => {},
    });
    expect(res.bodyUsed).toBe(false);
    expect(await res.text()).toBe("data: x\n\n");
  });
});
