// call-analyze: a thrown gateway error must leave the analysis in a TERMINAL state.
//
// Background: every in-band failure in call-analyze writes
// `call_analyses.status = "failed"`. But aiGatewayFetch THROWS on timeout /
// network / missing key, and that throw escaped to the handler's outer catch,
// which is out of scope for `analysisId` — so the row stayed "processing"
// for ever: not visible as a failure and never re-run.
//
// This file is BEHAVIOURAL for the error classification (it drives the real
// aiGatewayFetch and asserts the exact expression the catch block uses); the
// database write itself is guarded as source text in
// src/test/aiGatewayCallSiteShape.test.ts, because the handler is a
// `Deno.serve` closure that cannot be imported and driven.
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { aiGatewayFetch, AiGatewayError } from "../_shared/aiGateway.ts";

/** The exact classification call-analyze's catch block performs. */
function reasonFor(err: unknown): string {
  return `ai_${err instanceof AiGatewayError ? err.kind : "exception"}`;
}

const hanging = ((_url: string, init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as unknown as typeof fetch;

Deno.test("a timed-out gateway call classifies as ai_timeout (not a generic exception)", async () => {
  const err = await assertRejects(
    () => aiGatewayFetch("k", { model: "m" }, { fetchImpl: hanging, timeoutMs: 10, log: () => {} }),
    AiGatewayError,
  );
  assertEquals(err.kind, "timeout");
  assertEquals(reasonFor(err), "ai_timeout");
});

Deno.test("network failure and missing key classify distinctly", async () => {
  const failing = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
  assertEquals(
    reasonFor(await assertRejects(() => aiGatewayFetch("k", { model: "m" }, { fetchImpl: failing, log: () => {} }))),
    "ai_network",
  );
  assertEquals(
    reasonFor(await assertRejects(() => aiGatewayFetch(undefined, { model: "m" }, { fetchImpl: failing, log: () => {} }))),
    "ai_missing_key",
  );
});

Deno.test("a non-gateway throw still classifies, so no throw goes unlabelled", () => {
  assertEquals(reasonFor(new TypeError("boom")), "ai_exception");
  assertEquals(reasonFor("a string"), "ai_exception");
});
