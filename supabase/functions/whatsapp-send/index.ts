// ============================================================
// whatsapp-send — provider-agnostic outbound messaging
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encryptToken } from "../_shared/encryption.ts";
import { WhatsAppService } from "../_shared/whatsapp/service.ts";
import { assertConversationAccess } from "../_shared/authz.ts";
import { projectTimelineItem, whatsappDedupeKey } from "../_shared/timelineProjector.ts";

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

  // ── Auth ──────────────────────────────────────────
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

  // ── Parse body ────────────────────────────────────
  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { conversation_id, to, message_text } = body;
  if (!conversation_id || !to || !message_text) {
    return new Response(
      JSON.stringify({ error: "Missing required fields: conversation_id, to, message_text" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── Workspace-safe conversation access ─────────
  const authzCheck = await assertConversationAccess(supabase, conversation_id, userId);
  if (!authzCheck.ok) {
    return new Response(JSON.stringify({ error: authzCheck.error }), {
      status: authzCheck.status || 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: convo, error: convoErr } = await supabase
    .from("conversations")
    .select("id, workspace_id, integration_id, contact_id, owner_user_id")
    .eq("id", conversation_id)
    .single();

  if (convoErr || !convo) {
    return new Response(JSON.stringify({ error: "Conversation not found" }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!convo.integration_id) {
    return new Response(JSON.stringify({ error: "No integration linked to this conversation" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Send via provider abstraction ─────────────────
  let svc: WhatsAppService;
  try {
    svc = await WhatsAppService.forIntegration(supabase, convo.integration_id);
  } catch (err: any) {
    console.error("[whatsapp-send] Service init failed:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let providerMessageId: string;
  try {
    const result = await svc.sendMessage({ to, body: message_text });
    providerMessageId = result.providerMessageId;
  } catch (err: any) {
    console.error("[whatsapp-send] Send failed:", err.message);
    return new Response(
      JSON.stringify({ error: "WhatsApp API error", details: err.message }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // ── Store outbound message ────────────────────────
  const normalizedTo = to.replace(/\D/g, "");
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
  if (msgErr) console.error("[whatsapp-send] Failed to store outbound message:", msgErr);

  // Update conversation
  const { data: currentConvo } = await supabase
    .from("conversations").select("message_count").eq("id", conversation_id).single();

  await supabase.from("conversations").update({
    message_count: (currentConvo?.message_count ?? 0) + 1,
    last_message_at: now,
  }).eq("id", conversation_id);

  // ── Bridge to interactions table for lead timeline ──
  try {
    let bridgeLeadId: string | null = null;

    // Strategy 1: Use contact→lead link
    const { data: contactRow } = await supabase
      .from("contacts")
      .select("lead_id")
      .eq("id", convo.contact_id)
      .single();

    if (contactRow?.lead_id) {
      bridgeLeadId = contactRow.lead_id;
    } else {
      // Strategy 2: Workspace-scoped suffix match (only if unique)
      const { data: wsMembers } = await supabase
        .from("workspace_members")
        .select("user_id")
        .eq("workspace_id", convo.workspace_id);
      const memberIds = (wsMembers ?? []).map((m: any) => m.user_id);

      if (memberIds.length > 0) {
        const { data: candidates } = await supabase
          .from("leads")
          .select("id, phone, whatsapp_number")
          .in("owner_user_id", memberIds)
          .or("phone.neq.,whatsapp_number.neq.")
          .limit(200);

        const matches = (candidates ?? []).filter((l: any) => {
          const lp = ((l.whatsapp_number || l.phone || "").replace(/\D/g, ""));
          return lp.length >= 4 && normalizedTo.endsWith(lp);
        });

        if (matches.length === 1) {
          bridgeLeadId = matches[0].id;
          // Persist the link for future lookups
          await supabase.from("contacts")
            .update({ lead_id: bridgeLeadId })
            .eq("id", convo.contact_id)
            .is("lead_id", null);
        } else if (matches.length > 1) {
          console.warn(`[whatsapp-send] Ambiguous lead match (${matches.length}), skipping interaction bridge`);
        }
      }
    }

    if (bridgeLeadId) {
      const { data: waInteraction } = await supabase.from("interactions").insert({
        lead_id: bridgeLeadId,
        type: "whatsapp_outbound",
        source: "whatsapp",
        body_text: message_text,
        occurred_at: now,
        direction: "outbound",
        from_email: `+${normalizedTo}`,
      }).select("id").single();

      // Project to unified timeline
      if (waInteraction) {
        projectTimelineItem(supabase, {
          workspace_id: convo.workspace_id,
          lead_id: bridgeLeadId,
          channel: "whatsapp",
          provider: svc.providerType,
          direction: "outbound",
          event_type: "whatsapp_outbound",
          occurred_at: now,
          source_table: "interactions",
          source_id: waInteraction.id,
          snippet_text: message_text?.substring(0, 500),
          conversation_id: conversation_id,
          contact_id: convo.contact_id,
          metadata_json: { provider_message_id: providerMessageId, to: `+${normalizedTo}` },
          dedupe_key: whatsappDedupeKey("outbound", providerMessageId, waInteraction.id),
        }).catch(e => console.warn("[whatsapp-send] Timeline projection failed:", e));
      }
    }
  } catch (bridgeErr: any) {
    console.warn("[whatsapp-send] Non-blocking interaction bridge failed:", bridgeErr.message);
    await supabase.from("automation_logs").insert({
      workspace_id: convo.workspace_id,
      decision: "non_blocking_error",
      reason: `Interaction bridge failed: ${bridgeErr.message}`,
    }).then(() => {}).catch(() => {});
  }

  console.log("[whatsapp-send] Sent via", svc.providerType, ":", providerMessageId);

  return new Response(
    JSON.stringify({ ok: true, provider_message_id: providerMessageId }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
