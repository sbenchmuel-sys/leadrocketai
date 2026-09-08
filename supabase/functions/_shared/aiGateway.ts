// ============================================================================
// Shared AI gateway (Unit E-S1a)
//
// The ONE place that knows the Lovable AI gateway URL, builds the auth header,
// applies a timeout, retries once on transient gateway errors and emits a single
// usage/latency log line per call. Every edge-function AI call goes through
// `aiGatewayFetch` — `src/test/aiGatewaySingleSource.test.ts` fails the build if
// the literal "lovable.dev" appears anywhere else under supabase/functions/.
//
// Pure module (no runtime globals, no Supabase client). Callers pass the API key in
// (the LOVABLE_API_KEY env value read at the call site), so vitest can import it.
//
// MECHANICAL wrapper by design: it returns the raw `Response`, exactly like
// `fetch` did, so each call site keeps its own model, body shape, response
// parsing and streaming behaviour. Do not add model/prompt policy here.
// ============================================================================

export const AI_GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
// Time-to-first-byte budget. Once headers arrive the timer is cleared so a
// streamed body is never cut off mid-stream.
export const AI_GATEWAY_TIMEOUT_MS = 90_000;
export const AI_GATEWAY_RETRY_BACKOFF_MS = 2_000;

export type AiGatewayErrorKind = "missing_key" | "timeout" | "network";

export class AiGatewayError extends Error {
  readonly kind: AiGatewayErrorKind;
  readonly label: string;
  constructor(kind: AiGatewayErrorKind, label: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause ? String(cause) : "";
    super(`AI gateway ${kind}${label ? ` [${label}]` : ""}${detail ? `: ${detail}` : ""}`);
    this.name = "AiGatewayError";
    this.kind = kind;
    this.label = label;
  }
}

export interface AiGatewayOptions {
  /** Short tag for the log line, e.g. "ai_task:primary" or "call-analyze". */
  label?: string;
  timeoutMs?: number;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export function buildAuthHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

/** 429 / 402 / 5xx are the gateway's transient-or-quota errors: retry exactly once. */
export function isRetryableGatewayStatus(status: number): boolean {
  return status === 429 || status === 402 || status >= 500;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * POST `body` (JSON-serialised) to the AI gateway and return the raw Response.
 *
 * - throws AiGatewayError("missing_key") when apiKey is empty
 * - throws AiGatewayError("timeout") when no headers arrive within timeoutMs
 * - throws AiGatewayError("network") when fetch itself rejects
 * - on 429 / 402 / 5xx waits 2s and retries once; the second response is
 *   returned as-is (callers keep their existing `!res.ok` handling)
 * - logs one line: {"tag":"ai_gateway",label,model,status,ms,attempts,usage}
 */
export async function aiGatewayFetch(
  apiKey: string | undefined | null,
  body: unknown,
  opts: AiGatewayOptions = {},
): Promise<Response> {
  const label = opts.label ?? "";
  if (!apiKey) throw new AiGatewayError("missing_key", label);

  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? ((line: string) => console.log(line));
  const timeoutMs = opts.timeoutMs ?? AI_GATEWAY_TIMEOUT_MS;
  const bodyObj = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const model = typeof bodyObj.model === "string" ? bodyObj.model : undefined;
  const streaming = bodyObj.stream === true;
  const payload = JSON.stringify(body);
  const headers = buildAuthHeaders(apiKey);

  const started = Date.now();
  let attempts = 0;
  let res: Response;
  for (;;) {
    attempts++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      res = await fetchImpl(AI_GATEWAY_URL, { method: "POST", headers, body: payload, signal: ac.signal });
    } catch (err) {
      const kind: AiGatewayErrorKind = ac.signal.aborted ? "timeout" : "network";
      log(JSON.stringify({ tag: "ai_gateway", label, model, error: kind, ms: Date.now() - started, attempts }));
      throw new AiGatewayError(kind, label, err);
    } finally {
      clearTimeout(timer);
    }
    if (attempts === 1 && isRetryableGatewayStatus(res.status)) {
      // Drain the failed body so the connection can be reused, then back off.
      await res.text().catch(() => {});
      await sleep(AI_GATEWAY_RETRY_BACKOFF_MS);
      continue;
    }
    break;
  }

  // Usage comes from the JSON body; read it off a clone so the caller's own
  // `.json()` / `.text()` still works. Skipped for streams and error bodies.
  let usage: unknown;
  if (res.ok && !streaming) {
    try {
      const parsed = await res.clone().json();
      usage = parsed?.usage;
    } catch { /* non-JSON body — caller will deal with it */ }
  }
  log(JSON.stringify({ tag: "ai_gateway", label, model, status: res.status, ms: Date.now() - started, attempts, usage }));
  return res;
}
