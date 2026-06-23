// ============================================================
// cron-dispatcher — Secure relay for pg_cron → edge functions
//
// pg_cron can only pass static headers (no env var access).
// This function reads INTERNAL_API_SECRET from env and forwards
// the call to the target function with proper X-Internal-Secret.
//
// AUTH: Requires X-Internal-Secret (from the `app.internal_api_secret` DB
// setting that pg_cron injects) or a service-role Bearer token. Anon key and
// user JWTs are NOT accepted — this is not a user-facing endpoint.
//
// Called by pg_cron with header X-Internal-Secret and body
// { "target": "automation-executor" }.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireScheduledCaller } from "../_shared/scheduledAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Strict allowlist — the ONLY functions that can be dispatched.
// Adding a target here requires a code change + deploy.
const ALLOWED_TARGETS = new Set([
  "automation-executor",
  "nurture-pre-generate",
  "outlook-subscription-check",
  "gmail-bulk-sync",
  "promote-winning-interactions",
  "message-cleanup",
  "generate-reply-suggestions",
  "compute-manager-analytics",
  "whatsapp-events-processor",
  "detect-lead-candidates",
  "score-lead-candidate",
  "lookback-seed-candidates",
  "calendar-sync",
  "transcript-poller",
  "classify-inbound",
  "classify-outbound",
  "intelligence-queue-drain",
  "campaign-touch-scheduler",
]) as ReadonlySet<string>;

// Timeout for forwarded fetch calls (prevents hanging)
const FORWARD_TIMEOUT_MS = 55_000; // 55s — under the 60s Edge Function limit

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  // ── Auth gate ──────────────────────────────────────────────
  // The dispatcher relays the real INTERNAL_API_SECRET to allowlisted targets,
  // so it MUST authenticate its own caller first. pg_cron sends X-Internal-Secret
  // (from the `app.internal_api_secret` DB setting — see the cron-auth migration)
  // or a service-role Bearer; anon key / user JWTs are not privileged. Without
  // this gate, any unauthenticated caller could POST {"target": ...} and trigger
  // service-role cron work (Codex P1 on PR #109).
  const auth = requireScheduledCaller(req, corsHeaders);
  if (auth instanceof Response) return auth;

  const internalSecret = Deno.env.get("INTERNAL_API_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (!internalSecret) {
    console.error(`[cron-dispatcher] [${requestId}] INTERNAL_API_SECRET not configured`);
    return jsonResp({ error: "Not configured" }, 500);
  }

  // ── Parse request body ────────────────────────────────────
  let body: { target?: string; payload?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return jsonResp({ error: "Invalid JSON" }, 400);
  }

  const target = body.target;
  if (!target || !ALLOWED_TARGETS.has(target)) {
    return jsonResp({ error: `Unknown or disallowed target: ${target}` }, 400);
  }

  // ── Durable log: insert start record ──────────────────────
  const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

  await serviceClient.from("cron_run_log").insert({
    job_name: "cron-dispatcher",
    dispatcher_target: target,
    request_id: requestId,
    started_at: new Date(startedAt).toISOString(),
    status: "running",
  }).then(({ error }) => {
    if (error) console.warn(`[cron-dispatcher] [${requestId}] Failed to insert run log:`, error.message);
  });

  // ── Forward to target with timeout ────────────────────────
  const targetUrl = `${supabaseUrl}/functions/v1/${target}`;
  const forwardPayload = body.payload ?? { trigger: "pg_cron", time: new Date().toISOString() };

  let status_code: number;
  let resultBody: string;
  let finalStatus: string;
  let errorMessage: string | null = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

    const resp = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": internalSecret,
      },
      body: JSON.stringify(forwardPayload),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    status_code = resp.status;
    resultBody = await resp.text();
    finalStatus = resp.ok ? "ok" : "error";

    if (!resp.ok) {
      // Capture first 500 chars of error body for debugging
      errorMessage = resultBody.slice(0, 500);
    }
  } catch (err) {
    const isAbort = err instanceof DOMException && err.name === "AbortError";
    status_code = isAbort ? 504 : 502;
    resultBody = JSON.stringify({ error: isAbort ? "Timeout" : "Dispatch failed" });
    finalStatus = isAbort ? "timeout" : "error";
    errorMessage = isAbort
      ? `Target ${target} did not respond within ${FORWARD_TIMEOUT_MS}ms`
      : (err instanceof Error ? err.message : String(err));
  }

  // ── Durable log: update completion ────────────────────────
  const completedAt = Date.now();
  const durationMs = completedAt - startedAt;

  await serviceClient.from("cron_run_log").update({
    completed_at: new Date(completedAt).toISOString(),
    duration_ms: durationMs,
    status: finalStatus,
    status_code,
    error_message: errorMessage,
  }).eq("request_id", requestId).then(({ error }) => {
    if (error) console.warn(`[cron-dispatcher] [${requestId}] Failed to update run log:`, error.message);
  });

  // ── Structured console log ────────────────────────────────
  const logPayload = {
    request_id: requestId,
    target,
    started_at: new Date(startedAt).toISOString(),
    completed_at: new Date(completedAt).toISOString(),
    duration_ms: durationMs,
    status: finalStatus,
    status_code,
    ...(errorMessage ? { error_message: errorMessage.slice(0, 200) } : {}),
  };

  if (finalStatus === "ok") {
    console.log(`[cron-dispatcher] ✓`, JSON.stringify(logPayload));
  } else {
    console.error(`[cron-dispatcher] ✗`, JSON.stringify(logPayload));
  }

  return new Response(resultBody, {
    status: status_code,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});

// ── Helpers ─────────────────────────────────────────────────

function jsonResp(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
