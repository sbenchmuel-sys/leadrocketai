import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encryptToken } from "../_shared/encryption.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // ── GET → Meta webhook verification ──────────────────────────
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    const expectedToken = Deno.env.get("WHATSAPP_VERIFY_TOKEN");
    const verifyToken = "leadrocket-wa-verify-2026";
    console.log("[whatsapp-webhook] Verify check:", { mode, tokenMatch: token === verifyToken });

    if (mode === "subscribe" && token === verifyToken) {
      console.log("[whatsapp-webhook] Verification successful");
      return new Response(challenge, { status: 200, headers: corsHeaders });
    }

    console.warn("[whatsapp-webhook] Verification failed", { mode, token, expectedLen: expectedToken?.length });
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }

  // ── POST → Inbound message ingestion ─────────────────────────
  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Meta sends an array of entries, each with an array of changes
  const entries = body?.entry ?? [];
  let processed = 0;
  let skipped = 0;

  for (const entry of entries) {
    const changes = entry?.changes ?? [];
    for (const change of changes) {
      if (change?.field !== "messages") continue;

      const value = change?.value;
      if (!value) continue;

      const wabaId = entry?.id; // The WABA ID from the entry
      const phoneNumberId =
        value?.metadata?.phone_number_id;

      if (!phoneNumberId) {
        console.warn("[whatsapp-webhook] Missing phone_number_id, skipping");
        skipped++;
        continue;
      }

      // Find the integration that owns this phone_number_id
      const { data: integration, error: intErr } = await supabase
        .from("integrations")
        .select("id, workspace_id, user_id")
        .eq("type", "whatsapp")
        .eq("provider_account_id", phoneNumberId)
        .eq("is_active", true)
        .maybeSingle();

      if (intErr || !integration) {
        console.warn(
          "[whatsapp-webhook] No active integration for phone_number_id:",
          phoneNumberId,
          intErr
        );
        skipped++;
        continue;
      }

      const { workspace_id, user_id: ownerUserId, id: integrationId } =
        integration;

      // Process contacts (status updates, etc.) – we only care about messages
      const messages = value?.messages ?? [];

      for (const msg of messages) {
        const providerMessageId = msg?.id;
        if (!providerMessageId) {
          skipped++;
          continue;
        }

        // ── Idempotency check ──────────────────────────
        const { data: existing } = await supabase
          .from("messages")
          .select("id")
          .eq("provider_message_id", providerMessageId)
          .eq("workspace_id", workspace_id)
          .maybeSingle();

        if (existing) {
          console.log(
            "[whatsapp-webhook] Duplicate message, skipping:",
            providerMessageId
          );
          skipped++;
          continue;
        }

        const senderPhone = msg?.from; // e.g. "14155238886"
        const timestamp = msg?.timestamp
          ? new Date(parseInt(msg.timestamp) * 1000).toISOString()
          : new Date().toISOString();

        // Extract message body based on type
        let bodyText = "";
        if (msg.type === "text") {
          bodyText = msg.text?.body ?? "";
        } else if (msg.type === "image") {
          bodyText = `[Image] ${msg.image?.caption ?? ""}`;
        } else if (msg.type === "document") {
          bodyText = `[Document] ${msg.document?.filename ?? ""}`;
        } else if (msg.type === "audio") {
          bodyText = "[Audio message]";
        } else if (msg.type === "video") {
          bodyText = `[Video] ${msg.video?.caption ?? ""}`;
        } else if (msg.type === "location") {
          bodyText = `[Location] ${msg.location?.latitude},${msg.location?.longitude}`;
        } else if (msg.type === "contacts") {
          bodyText = `[Contact card]`;
        } else if (msg.type === "sticker") {
          bodyText = "[Sticker]";
        } else if (msg.type === "reaction") {
          bodyText = `[Reaction] ${msg.reaction?.emoji ?? ""}`;
        } else {
          bodyText = `[${msg.type ?? "unknown"}]`;
        }

        // ── Resolve or create contact ──────────────────
        let contactId: string;
        const normalizedPhone = senderPhone.replace(/\D/g, "");

        // Look up by identity
        const { data: identityRow } = await supabase
          .from("contact_identities")
          .select("contact_id")
          .eq("workspace_id", workspace_id)
          .eq("type", "phone")
          .eq("value", normalizedPhone)
          .maybeSingle();

        if (identityRow) {
          contactId = identityRow.contact_id;
          // Update last_activity_at on the contact
          await supabase
            .from("contacts")
            .update({ last_activity_at: timestamp })
            .eq("id", contactId);
        } else {
          // Auto-create unclassified contact
          const { data: newContact, error: cErr } = await supabase
            .from("contacts")
            .insert({
              workspace_id,
              status: "unclassified",
              display_name: `+${normalizedPhone}`,
              last_activity_at: timestamp,
            })
            .select("id")
            .single();

          if (cErr || !newContact) {
            console.error(
              "[whatsapp-webhook] Failed to create contact:",
              cErr
            );
            skipped++;
            continue;
          }

          contactId = newContact.id;

          // Create the phone identity
          await supabase.from("contact_identities").insert({
            workspace_id,
            contact_id: contactId,
            type: "phone",
            value: normalizedPhone,
            is_primary: true,
          });

          console.log(
            "[whatsapp-webhook] Created new contact:",
            contactId,
            "for phone:",
            normalizedPhone
          );
        }

        // ── Resolve or create conversation ─────────────
        let conversationId: string;

        const { data: existingConvo } = await supabase
          .from("conversations")
          .select("id")
          .eq("workspace_id", workspace_id)
          .eq("contact_id", contactId)
          .eq("channel", "whatsapp")
          .eq("owner_user_id", ownerUserId)
          .eq("status", "open")
          .maybeSingle();

        if (existingConvo) {
          conversationId = existingConvo.id;
          // Update conversation timestamps
          await supabase
            .from("conversations")
            .update({
              last_message_at: timestamp,
              message_count: (existingConvo as any).message_count
                ? (existingConvo as any).message_count + 1
                : 1,
            })
            .eq("id", conversationId);
        } else {
          const { data: newConvo, error: cvErr } = await supabase
            .from("conversations")
            .insert({
              workspace_id,
              contact_id: contactId,
              channel: "whatsapp",
              owner_user_id: ownerUserId,
              integration_id: integrationId,
              provider_thread_id: senderPhone,
              status: "open",
              last_message_at: timestamp,
              message_count: 1,
            })
            .select("id")
            .single();

          if (cvErr || !newConvo) {
            console.error(
              "[whatsapp-webhook] Failed to create conversation:",
              cvErr
            );
            skipped++;
            continue;
          }
          conversationId = newConvo.id;
        }

        // ── Encrypt and store message ──────────────────
        const encryptedBody = await encryptToken(bodyText);
        const expiresAt = new Date(
          Date.now() + 72 * 60 * 60 * 1000
        ).toISOString();

        // Resolve sender identity ID for the message
        const { data: senderIdentity } = await supabase
          .from("contact_identities")
          .select("id")
          .eq("workspace_id", workspace_id)
          .eq("contact_id", contactId)
          .eq("type", "phone")
          .eq("value", normalizedPhone)
          .maybeSingle();

        const { error: msgErr } = await supabase.from("messages").insert({
          workspace_id,
          conversation_id: conversationId,
          direction: "inbound",
          body_ciphertext: encryptedBody,
          expires_at: expiresAt,
          provider_message_id: providerMessageId,
          sender_identity_id: senderIdentity?.id ?? null,
          media_type: msg.type !== "text" ? msg.type : null,
          created_at: timestamp,
        });

        if (msgErr) {
          console.error("[whatsapp-webhook] Failed to store message:", msgErr);
          skipped++;
          continue;
        }

        // ── Bridge to interactions table for lead timeline ──
        // Try matching normalizedPhone suffix against leads.phone
        // Leads store local numbers (e.g. "9210029244"), webhook gets full E.164 (e.g. "919210029244")
        const { data: matchedLead } = await supabase
          .from("leads")
          .select("id, owner_user_id")
          .filter("phone", "neq", "")
          .not("phone", "is", null)
          .limit(100);

        if (matchedLead && matchedLead.length > 0) {
          const lead = matchedLead.find((l: any) => {
            const leadPhone = (l.phone || "").replace(/\D/g, "");
            return leadPhone.length >= 4 && normalizedPhone.endsWith(leadPhone);
          });

          if (lead) {
            const { error: intxErr } = await supabase
              .from("interactions")
              .insert({
                lead_id: lead.id,
                type: "whatsapp_inbound",
                source: "whatsapp",
                body_text: bodyText,
                occurred_at: timestamp,
                direction: "inbound",
                from_email: `+${normalizedPhone}`,
              });

            if (intxErr) {
              console.error("[whatsapp-webhook] Failed to bridge to interactions:", intxErr);
            } else {
              console.log("[whatsapp-webhook] Bridged inbound to lead:", lead.id);
            }
          }
        }

        processed++;
        console.log(
          "[whatsapp-webhook] Stored message:",
          providerMessageId,
          "for contact:",
          contactId
        );
      }
    }
  }

  return new Response(
    JSON.stringify({ ok: true, processed, skipped }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
});
