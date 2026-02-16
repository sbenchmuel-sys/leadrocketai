import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { safeDecryptToken } from "../_shared/encryption.ts";
import { encryptToken } from "../_shared/encryption.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const WA_API = "https://graph.facebook.com/v21.0";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  // ── Auth ──────────────────────────────────────────
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

  // ── Parse body ────────────────────────────────────
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { conversation_id, to, message_text } = body;

  if (!conversation_id || !to || !message_text) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: conversation_id, to, message_text" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // ── Load conversation + integration ───────────────
  const { data: convo, error: convoErr } = await supabase
    .from("conversations")
    .select("id, workspace_id, integration_id, contact_id, owner_user_id")
    .eq("id", conversation_id)
    .single();

  if (convoErr || !convo) {
    return new Response(JSON.stringify({ error: "Conversation not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Verify the caller owns this conversation
  if (convo.owner_user_id !== userId) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!convo.integration_id) {
    return new Response(JSON.stringify({ error: "No integration linked to this conversation" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Load integration credentials ──────────────────
  const { data: integration, error: intErr } = await supabase
    .from("integrations")
    .select("id, credentials_encrypted, provider_account_id, is_active")
    .eq("id", convo.integration_id)
    .single();

  if (intErr || !integration || !integration.is_active) {
    return new Response(JSON.stringify({ error: "WhatsApp integration not found or inactive" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!integration.credentials_encrypted) {
    return new Response(JSON.stringify({ error: "No credentials stored for this integration" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Decrypt credentials ───────────────────────────
  let accessToken: string;
  // Use provider_account_id as the canonical phone number ID
  const phoneNumberId = integration.provider_account_id!;

  try {
    const credsJson = await safeDecryptToken(integration.credentials_encrypted);
    const creds = JSON.parse(credsJson);
    // access_token inside is individually encrypted
    accessToken = await safeDecryptToken(creds.access_token);
  } catch (err) {
    console.error("[whatsapp-send] Failed to decrypt credentials:", err);
    return new Response(JSON.stringify({ error: "Failed to decrypt credentials" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Send via WhatsApp Cloud API ───────────────────
  const normalizedTo = to.replace(/\D/g, "");

  const waPayload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizedTo,
    type: "text",
    text: { body: message_text },
  };

  const waRes = await fetch(`${WA_API}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(waPayload),
  });

  const waData = await waRes.json();

  if (!waRes.ok) {
    console.error("[whatsapp-send] Cloud API error:", waRes.status, waData);
    return new Response(
      JSON.stringify({ error: "WhatsApp API error", details: waData?.error?.message ?? waData }),
      { status: waRes.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const providerMessageId = waData?.messages?.[0]?.id ?? null;

  // ── Store outbound message ────────────────────────
  const encryptedBody = await encryptToken(message_text);
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  const { error: msgErr } = await supabase.from("messages").insert({
    workspace_id: convo.workspace_id,
    conversation_id,
    direction: "outbound",
    body_ciphertext: encryptedBody,
    expires_at: expiresAt,
    provider_message_id: providerMessageId,
    sender_identity_id: null,
    created_at: now,
  });

  if (msgErr) {
    console.error("[whatsapp-send] Failed to store outbound message:", msgErr);
  }

  // Update conversation last_message_at
  await supabase
    .from("conversations")
    .update({ last_message_at: now })
    .eq("id", conversation_id);

  console.log("[whatsapp-send] Message sent:", providerMessageId, "to:", normalizedTo);

  return new Response(
    JSON.stringify({ ok: true, provider_message_id: providerMessageId }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
