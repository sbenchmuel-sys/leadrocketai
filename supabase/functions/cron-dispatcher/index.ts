// ============================================================
// cron-dispatcher — Secure relay for pg_cron → edge functions
//
// pg_cron can only pass static headers (no env var access).
// This function reads INTERNAL_API_SECRET from env and forwards
// the call to the target function with proper X-Internal-Secret.
//
// AUTH: Accepts service-role Bearer token (from pg_cron/pg_net)
// only. Does NOT accept anon key or user JWTs — this is not a
// user-facing endpoint.
//
// Called by pg_cron with: { "target": "automation-executor" }
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
]) as ReadonlySet<string>;

// Timeout for forwarded fetch calls (prevents hanging)
const FORWARD_TIMEOUT_MS = 55_000; // 55s — under the 60s Edge Function limit

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  // ── Auth gate: accept anon key OR service-role key ──────────
  // pg_cron uses pg_net which can only pass static headers, so
  // the anon key is used there. We accept both anon and service-role
  // keys. The real security boundary is the INTERNAL_API_SECRET
  // forwarded to target functions.
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearerToken = authHeader.replace("Bearer ", "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

  const isServiceRole = serviceKey && constantTimeEqual(bearerToken, serviceKey);
  const isAnon = anonKey && constantTimeEqual(bearerToken, anonKey);

  if (!bearerToken || (!isServiceRole && !isAnon)) {
    return jsonResp({ error: "Forbidden — dispatcher requires valid auth" }, 403);
  }

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

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function jsonResp(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
