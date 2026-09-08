// Run: deno test --allow-read --allow-env supabase/functions/_shared/aiGateway.test.ts
//
// Behavioural contract of the shared AI gateway wrapper. A vitest mirror of
// these cases lives in src/test/aiGatewayBehaviour.test.ts (runs in `npm test`).
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  AI_GATEWAY_URL,
  AiGatewayError,
  aiGatewayFetch,
} from "./aiGateway.ts";

interface Seen { url: string; init: RequestInit }

function fakeFetch(responses: Array<() => Response | Promise<Response>>, seen: Seen[]): typeof fetch {
  let i = 0;
  return ((url: string, init: RequestInit) => {
    seen.push({ url, init });
    const next = responses[Math.min(i++, responses.length - 1)];
    return Promise.resolve(next());
  }) as unknown as typeof fetch;
}

const okJson = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { total_tokens: 7 } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const noSleep = () => Promise.resolve();

Deno.test("retries once on 429 then returns the successful response", async () => {
  const seen: Seen[] = [];
  const logs: string[] = [];
  const res = await aiGatewayFetch("k", { model: "m" }, {
    fetchImpl: fakeFetch([() => new Response("slow down", { status: 429 }), okJson], seen),
    sleep: noSleep,
    log: (l) => logs.push(l),
  });
  assertEquals(res.status, 200);
  assertEquals(seen.length, 2);
  // Caller can still read the body after the gateway peeked at usage.
  const json = await res.json();
  assertEquals(json.choices[0].message.content, "hi");
  assertEquals(logs.length, 1);
  const line = JSON.parse(logs[0]);
  assertEquals(line.tag, "ai_gateway");
  assertEquals(line.attempts, 2);
  assertEquals(line.usage.total_tokens, 7);
});

Deno.test("does not retry on 400 or 402 and returns the response untouched", async () => {
  for (const status of [400, 402]) {
    const seen: Seen[] = [];
    const res = await aiGatewayFetch("k", { model: "m" }, {
      fetchImpl: fakeFetch([() => new Response("bad", { status })], seen),
      sleep: noSleep,
      log: () => {},
    });
    assertEquals(res.status, status);
    assertEquals(seen.length, 1);
    assertEquals(await res.text(), "bad");
  }
});

Deno.test("retries exactly once on 5xx — second failure is returned, not retried again", async () => {
  const seen: Seen[] = [];
  const res = await aiGatewayFetch("k", { model: "m" }, {
    fetchImpl: fakeFetch([() => new Response("down", { status: 503 })], seen),
    sleep: noSleep,
    log: () => {},
  });
  assertEquals(res.status, 503);
  assertEquals(seen.length, 2);
});

Deno.test("timeout surfaces a typed AiGatewayError(kind=timeout)", async () => {
  const hanging = ((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
  const err = await assertRejects(
    () => aiGatewayFetch("k", { model: "m" }, { fetchImpl: hanging, timeoutMs: 10, log: () => {} }),
    AiGatewayError,
  );
  assertEquals(err.kind, "timeout");
});

Deno.test("per-call timeoutMs override is honoured", async () => {
  const slow = ((_url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => resolve(okJson()), 40);
      init.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); });
    })) as unknown as typeof fetch;
  const ok = await aiGatewayFetch("k", { model: "m" }, { fetchImpl: slow, timeoutMs: 2_000, log: () => {} });
  assertEquals(ok.status, 200);
  const err = await assertRejects(
    () => aiGatewayFetch("k", { model: "m" }, { fetchImpl: slow, timeoutMs: 5, log: () => {} }),
    AiGatewayError,
  );
  assertEquals(err.kind, "timeout");
});

Deno.test("missing key surfaces a typed AiGatewayError(kind=missing_key) without calling fetch", async () => {
  const seen: Seen[] = [];
  const err = await assertRejects(
    () => aiGatewayFetch(undefined, { model: "m" }, { fetchImpl: fakeFetch([okJson], seen), log: () => {} }),
    AiGatewayError,
  );
  assertEquals(err.kind, "missing_key");
  assertEquals(seen.length, 0);
});

Deno.test("sets the bearer auth header, JSON content type, the single URL and the serialised body", async () => {
  const seen: Seen[] = [];
  await aiGatewayFetch("secret-key", { model: "m", messages: [] }, {
    fetchImpl: fakeFetch([okJson], seen),
    log: () => {},
  });
  assertEquals(seen[0].url, AI_GATEWAY_URL);
  const headers = seen[0].init.headers as Record<string, string>;
  assertEquals(headers.Authorization, "Bearer secret-key");
  assertEquals(headers["Content-Type"], "application/json");
  assertEquals(seen[0].init.method, "POST");
  assertEquals(seen[0].init.body, JSON.stringify({ model: "m", messages: [] }));
});

Deno.test("streaming requests are returned without the body being consumed", async () => {
  const seen: Seen[] = [];
  const res = await aiGatewayFetch("k", { model: "m", stream: true }, {
    fetchImpl: fakeFetch([() => new Response("data: x\n\n", { status: 200 })], seen),
    log: () => {},
  });
  assertEquals(res.bodyUsed, false);
  assertEquals(await res.text(), "data: x\n\n");
});
