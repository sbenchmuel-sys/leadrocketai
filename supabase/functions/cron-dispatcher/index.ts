// ============================================================
// cron-dispatcher — Secure relay for pg_cron → edge functions
//
// pg_cron can only pass static headers (no env var access).
// This function reads INTERNAL_API_SECRET from env and forwards
// the call to the target function with proper X-Internal-Secret.
//
// Called by pg_cron with: { "target": "automation-executor" }
// ============================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Allowlist of functions that can be dispatched via cron
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
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const internalSecret = Deno.env.get("INTERNAL_API_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;

  if (!internalSecret) {
    console.error("[cron-dispatcher] INTERNAL_API_SECRET not configured");
    return new Response(JSON.stringify({ error: "Not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: { target?: string; payload?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const target = body.target;
  if (!target || !ALLOWED_TARGETS.has(target)) {
    return new Response(JSON.stringify({ error: `Unknown or disallowed target: ${target}` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const targetUrl = `${supabaseUrl}/functions/v1/${target}`;
  const forwardPayload = body.payload ?? { trigger: "pg_cron", time: new Date().toISOString() };

  try {
    const resp = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": internalSecret,
      },
      body: JSON.stringify(forwardPayload),
    });

    const result = await resp.text();
    console.log(`[cron-dispatcher] ${target} → ${resp.status}`);

    return new Response(result, {
      status: resp.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(`[cron-dispatcher] Failed to call ${target}:`, err instanceof Error ? err.message : String(err));
    return new Response(JSON.stringify({ error: "Dispatch failed" }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
