// ============================================================
// whatsapp-health — provider-agnostic health check
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { WhatsAppService } from "../_shared/whatsapp/service.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  // ── Authenticate ─────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseAuth = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const token = authHeader.replace("Bearer ", "");
  const { data: claims, error: claimsErr } = await supabaseAuth.auth.getClaims(token);
  if (claimsErr || !claims?.claims) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const userId = claims.claims.sub as string;

  // ── Get workspace_id ─────────────────────────────
  const url = new URL(req.url);
  let workspaceId = url.searchParams.get("workspace_id");
  if (!workspaceId && req.method === "POST") {
    try { const b = await req.json(); workspaceId = b.workspace_id; } catch { /* ignore */ }
  }
  if (!workspaceId) {
    return new Response(JSON.stringify({ error: "workspace_id required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── Check if integration exists ──────────────────
  const { data: integration } = await supabase
    .from("integrations")
    .select("id, is_active, last_sync_at, provider")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("type", "whatsapp")
    .maybeSingle();

  if (!integration) {
    return new Response(
      JSON.stringify({ connected: false, error: "No WhatsApp connection found" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (!integration.is_active) {
    return new Response(
      JSON.stringify({ connected: false, status: "inactive", integration_id: integration.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ── Health check via provider abstraction ─────────
  try {
    const svc = await WhatsAppService.forIntegration(supabase, integration.id);
    const health = await svc.healthCheck();

    return new Response(
      JSON.stringify({
        connected: true,
        healthy: health.healthy,
        status: health.status,
        integration_id: integration.id,
        provider: integration.provider ?? "meta",
        phone_number_id: health.phoneNumberId ?? null,
        verified_name: health.verifiedName ?? null,
        last_sync_at: integration.last_sync_at,
        error: health.errorMessage ?? undefined,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("[whatsapp-health] Error:", err.message);
    return new Response(
      JSON.stringify({
        connected: true,
        healthy: false,
        status: "error",
        error: err.message,
        integration_id: integration.id,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
