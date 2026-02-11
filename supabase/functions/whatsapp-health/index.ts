import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { safeDecryptToken } from "../_shared/encryption.ts";

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

  // Authenticate
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseAuth = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const token = authHeader.replace("Bearer ", "");
  const { data: claims, error: claimsErr } = await supabaseAuth.auth.getClaims(token);
  if (claimsErr || !claims?.claims) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userId = claims.claims.sub as string;

  // Get workspace_id from query or body
  const url = new URL(req.url);
  let workspaceId = url.searchParams.get("workspace_id");

  if (!workspaceId && req.method === "POST") {
    try {
      const body = await req.json();
      workspaceId = body.workspace_id;
    } catch { /* ignore */ }
  }

  if (!workspaceId) {
    return new Response(JSON.stringify({ error: "workspace_id required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Service role for reading encrypted credentials
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Get the integration
  const { data: integration, error: intErr } = await supabase
    .from("integrations")
    .select("id, credentials_encrypted, provider_account_id, is_active, last_sync_at")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("type", "whatsapp")
    .maybeSingle();

  if (intErr || !integration) {
    return new Response(
      JSON.stringify({ connected: false, error: "No WhatsApp connection found" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!integration.is_active) {
    return new Response(
      JSON.stringify({ connected: false, status: "inactive", integration_id: integration.id }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Decrypt credentials and check WhatsApp API
  try {
    const creds = JSON.parse(integration.credentials_encrypted!);
    const accessToken = await safeDecryptToken(creds.access_token);
    const phoneNumberId = creds.phone_number_id ?? integration.provider_account_id;

    // Call WhatsApp Cloud API to verify the token is valid
    const waResponse = await fetch(
      `https://graph.facebook.com/v21.0/${phoneNumberId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (!waResponse.ok) {
      const errBody = await waResponse.text();
      console.warn("[whatsapp-health] API check failed:", waResponse.status, errBody);
      return new Response(
        JSON.stringify({
          connected: true,
          healthy: false,
          status: "token_invalid",
          integration_id: integration.id,
          last_sync_at: integration.last_sync_at,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const waData = await waResponse.json();

    return new Response(
      JSON.stringify({
        connected: true,
        healthy: true,
        status: "active",
        integration_id: integration.id,
        phone_number_id: phoneNumberId,
        verified_name: waData.verified_name ?? null,
        quality_rating: waData.quality_rating ?? null,
        last_sync_at: integration.last_sync_at,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[whatsapp-health] Error:", err);
    return new Response(
      JSON.stringify({
        connected: true,
        healthy: false,
        status: "error",
        error: err.message,
        integration_id: integration.id,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
