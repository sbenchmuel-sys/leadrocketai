import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encryptToken } from "../_shared/encryption.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  // Authenticate the rep
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

  // Parse request
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { workspace_id, access_token, phone_number_id, waba_id } = body;

  if (!workspace_id || !access_token || !phone_number_id) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: workspace_id, access_token, phone_number_id" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Use service role for DB operations
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Verify the user is a member of the workspace
  const { data: membership } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspace_id)
    .eq("user_id", userId)
    .maybeSingle();

  if (!membership) {
    return new Response(JSON.stringify({ error: "Not a member of this workspace" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Encrypt the access token
  const encryptedCredentials = JSON.stringify({
    access_token: await encryptToken(access_token),
    phone_number_id,
    waba_id: waba_id ?? null,
  });

  // Upsert the integration (one WhatsApp connection per user per workspace)
  const { data: existing } = await supabase
    .from("integrations")
    .select("id")
    .eq("workspace_id", workspace_id)
    .eq("user_id", userId)
    .eq("type", "whatsapp")
    .maybeSingle();

  let integrationId: string;

  if (existing) {
    const { error } = await supabase
      .from("integrations")
      .update({
        credentials_encrypted: encryptedCredentials,
        provider_account_id: phone_number_id,
        is_active: true,
        last_sync_at: new Date().toISOString(),
      })
      .eq("id", existing.id);

    if (error) {
      console.error("[whatsapp-connect] Update failed:", error);
      return new Response(JSON.stringify({ error: "Failed to update connection" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    integrationId = existing.id;
  } else {
    const { data: newInt, error } = await supabase
      .from("integrations")
      .insert({
        workspace_id,
        user_id: userId,
        type: "whatsapp",
        credentials_encrypted: encryptedCredentials,
        provider_account_id: phone_number_id,
        is_active: true,
        last_sync_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (error || !newInt) {
      console.error("[whatsapp-connect] Insert failed:", error);
      return new Response(JSON.stringify({ error: "Failed to create connection" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    integrationId = newInt.id;
  }

  console.log("[whatsapp-connect] Connection saved for user:", userId, "integration:", integrationId);

  return new Response(
    JSON.stringify({ ok: true, integration_id: integrationId }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
});
