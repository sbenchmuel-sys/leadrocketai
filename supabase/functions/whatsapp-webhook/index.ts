// ============================================================
// whatsapp-webhook — INGEST-ONLY (Phase 2 + Phase 3 normalize)
//
// Responsibilities:
//   1. GET  → Meta verification (WHATSAPP_VERIFY_TOKEN)
//   2. POST → Validate signature → normalize → route → store in channel_events
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyMetaSignature } from "../_shared/whatsapp/providers/meta.ts";
import { normalizeMetaWebhook, toChannelEventRows } from "../_shared/whatsapp/normalize.ts";
import { resolveWorkspaceByPhoneNumberId } from "../_shared/whatsapp/routing.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // ── GET → Meta webhook verification ─────────────────────
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const expectedToken = Deno.env.get("WHATSAPP_VERIFY_TOKEN");

    console.log("[whatsapp-webhook] Verify check:", { mode, tokenPresent: !!token });

    if (mode === "subscribe" && expectedToken && token === expectedToken) {
      console.log("[whatsapp-webhook] Verification successful");
      return new Response(challenge, { status: 200, headers: corsHeaders });
    }
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  // ── Read raw body for signature verification ────────────
  const rawBody = await req.text();

  // ── Signature verification (MUST happen before any data access) ──
  const metaAppSecret = Deno.env.get("META_APP_SECRET");
  if (!metaAppSecret) {
    console.error("[whatsapp-webhook] META_APP_SECRET not configured — rejecting request");
    return new Response(JSON.stringify({ error: "Webhook not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const sigValid = await verifyMetaSignature(req, rawBody, metaAppSecret);
  if (!sigValid) {
    console.warn("[whatsapp-webhook] Invalid Meta signature — rejecting");
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Parse JSON ──────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Normalize ───────────────────────────────────────────
  const result = normalizeMetaWebhook(body);
  const totalEvents = result.inboundEvents.length + result.statusEvents.length;

  if (totalEvents === 0) {
    return new Response(JSON.stringify({ ok: true, stored: 0 }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Route: resolve workspace ────────────────────────────
  let workspaceId: string | null = null;
  if (result.phoneNumberId) {
    const route = await resolveWorkspaceByPhoneNumberId(result.phoneNumberId);
    workspaceId = route.workspaceId;
  }

  // ── Convert to channel_events rows ──────────────────────
  const rows = toChannelEventRows(result, workspaceId, body);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let stored = 0;
  let duplicates = 0;

  for (const row of rows) {
    const { error: insertErr } = await supabase
      .from("channel_events")
      .insert(row);

    if (insertErr) {
      if (insertErr.code === "23505") {
        duplicates++;
        continue;
      }
      console.error("[whatsapp-webhook] Insert error:", insertErr.message);
      continue;
    }
    stored++;
  }

  console.log(
    `[whatsapp-webhook] Ingested: ${stored} stored, ${duplicates} duplicates, ${totalEvents} total`,
  );

  // ── Fire-and-forget: trigger async processor ────────────
  // Uses X-Internal-Secret when available for consistency,
  // falls back to anon key (processor is idempotent).
  if (stored > 0) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const internalSecret = Deno.env.get("INTERNAL_API_SECRET");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (internalSecret) {
      headers["X-Internal-Secret"] = internalSecret;
    } else {
      headers["Authorization"] = `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")!}`;
    }

    fetch(`${supabaseUrl}/functions/v1/whatsapp-events-processor`, {
      method: "POST",
      headers,
      body: JSON.stringify({ trigger: "webhook", stored }),
    }).catch((err) => {
      console.warn("[whatsapp-webhook] Failed to trigger processor (non-blocking):", err.message);
    });
  }

  return new Response(
    JSON.stringify({ ok: true, stored, duplicates }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
