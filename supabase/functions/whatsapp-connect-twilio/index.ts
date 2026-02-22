// ============================================================
// whatsapp-connect-twilio — Twilio embedded signup callback
//
// Receives Twilio WhatsApp signup completion and upserts
// an integration with type='whatsapp', provider='twilio'.
// ============================================================

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

  // ── Parse request ────────────────────────────────
  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const {
    workspace_id,
    twilio_sender_sid,           // Twilio WhatsApp Sender SID or Messaging Service SID
    twilio_phone_number,         // The WhatsApp-enabled phone number (e.g. "+14155238886")
    twilio_account_sid,          // Optional: per-workspace sub-account SID
    messaging_service_sid,       // Optional: Twilio Messaging Service SID
  } = body;

  if (!workspace_id || !twilio_phone_number) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: workspace_id, twilio_phone_number" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── Verify workspace membership ──────────────────
  const { data: membership } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspace_id)
    .eq("user_id", userId)
    .maybeSingle();

  if (!membership) {
    return new Response(JSON.stringify({ error: "Not a member of this workspace" }), {
      status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Build credentials blob ───────────────────────
  // For Twilio, we store workspace-specific identifiers (NOT the auth token).
  // The global TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN are in secrets.
  // Per-workspace sub-account details go in credentials_encrypted.
  const credentialPayload: Record<string, string | null> = {
    twilio_sender_sid: twilio_sender_sid ?? null,
    twilio_phone_number,
    twilio_account_sid: twilio_account_sid ?? null,
    messaging_service_sid: messaging_service_sid ?? null,
  };

  const encryptedCredentials = await encryptToken(JSON.stringify(credentialPayload));

  // provider_account_id = phone number digits (used for routing)
  const providerAccountId = twilio_phone_number.replace(/\D/g, "");

  // ── Upsert integration ───────────────────────────
  const { data: existing } = await supabase
    .from("integrations")
    .select("id")
    .eq("workspace_id", workspace_id)
    .eq("user_id", userId)
    .eq("type", "whatsapp")
    .eq("provider", "twilio")
    .maybeSingle();

  let integrationId: string;

  if (existing) {
    const { error } = await supabase
      .from("integrations")
      .update({
        credentials_encrypted: encryptedCredentials,
        provider_account_id: providerAccountId,
        is_active: true,
        last_sync_at: new Date().toISOString(),
      })
      .eq("id", existing.id);

    if (error) {
      console.error("[whatsapp-connect-twilio] Update failed:", error);
      return new Response(JSON.stringify({ error: "Failed to update connection" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
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
        provider: "twilio",
        credentials_encrypted: encryptedCredentials,
        provider_account_id: providerAccountId,
        is_active: true,
        last_sync_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (error || !newInt) {
      console.error("[whatsapp-connect-twilio] Insert failed:", error);
      return new Response(JSON.stringify({ error: "Failed to create connection" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    integrationId = newInt.id;
  }

  console.log(`[whatsapp-connect-twilio] Saved for user=${userId} integration=${integrationId}`);

  return new Response(
    JSON.stringify({ ok: true, integration_id: integrationId, provider: "twilio" }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
