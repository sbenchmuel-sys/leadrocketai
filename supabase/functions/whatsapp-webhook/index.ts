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
  let statusUpdated = 0;

  for (const entry of entries) {
    const changes = entry?.changes ?? [];
    for (const change of changes) {
      if (change?.field !== "messages") continue;

      const value = change?.value;
      if (!value) continue;

      // ── Status update events (sent/delivered/read/failed) ─────────
      // These arrive as value.statuses[] — process BEFORE message ingestion
      const statuses = value?.statuses ?? [];
      for (const statusEvent of statuses) {
        const providerMsgId = statusEvent?.id;
        const newStatus: string = statusEvent?.status; // sent | delivered | read | failed
        const recipientId: string = statusEvent?.recipient_id;

        if (!providerMsgId || !newStatus) continue;
        if (!["sent", "delivered", "read", "failed"].includes(newStatus)) continue;

        // Update message record
        const { error: statusErr } = await supabase
          .from("messages")
          .update({ status: newStatus })
          .eq("provider_message_id", providerMsgId);

        if (statusErr) {
          console.error("[whatsapp-webhook] Failed to update message status:", statusErr);
          continue;
        }

        console.log(`[whatsapp-webhook] Status update: ${providerMsgId} → ${newStatus}`);
        statusUpdated++;

        // ── Lead intelligence updates ──────────────────────────────
        if (newStatus === "read" || newStatus === "failed") {
          // Find lead by recipient phone suffix
          const normalizedRecipient = (recipientId || "").replace(/\D/g, "");
          if (!normalizedRecipient) continue;

          const { data: allLeads } = await supabase
            .from("leads")
            .select("id, needs_action, next_action_key")
            .filter("phone", "neq", "")
            .not("phone", "is", null)
            .limit(100);

          const matchedLead = (allLeads ?? []).find((l: any) => {
            const lp = (l.phone || "").replace(/\D/g, "");
            return lp.length >= 4 && normalizedRecipient.endsWith(lp);
          });

          if (matchedLead) {
            if (newStatus === "read") {
              await supabase.from("leads").update({
                last_read_at: new Date().toISOString(),
              } as any).eq("id", matchedLead.id);
              console.log(`[whatsapp-webhook] Marked last_read_at for lead ${matchedLead.id}`);
            } else if (newStatus === "failed") {
              // Only set needs_action if not already set with higher priority action
              if (!matchedLead.needs_action || matchedLead.next_action_key === "whatsapp_reply") {
                await supabase.from("leads").update({
                  needs_action: true,
                  next_action_key: "whatsapp_failed",
                  next_action_label: "WhatsApp message failed — retry",
                } as any).eq("id", matchedLead.id);
                console.log(`[whatsapp-webhook] Flagged failed delivery for lead ${matchedLead.id}`);
              }
            }
          }
        }
      }

      // If this change only contained status events (no messages[]), skip message ingestion
      const hasMessages = (value?.messages ?? []).length > 0;
      if (!hasMessages) continue;

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
          // Fetch current message_count and increment
          const { data: convoData } = await supabase
            .from("conversations")
            .select("message_count")
            .eq("id", existingConvo.id)
            .single();
          
          await supabase
            .from("conversations")
            .update({
              last_message_at: timestamp,
              message_count: (convoData?.message_count ?? 0) + 1,
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

        // ── Bridge to interactions table + update lead state ──
        // Try matching normalizedPhone suffix against leads.phone
        // Leads store local numbers (e.g. "9210029244"), webhook gets full E.164 (e.g. "919210029244")
        const { data: matchedLeads } = await supabase
          .from("leads")
          .select("id, owner_user_id, needs_action, next_action_key")
          .filter("phone", "neq", "")
          .not("phone", "is", null)
          .limit(100);

        let matchedLeadId: string | null = null;

        if (matchedLeads && matchedLeads.length > 0) {
          const lead = matchedLeads.find((l: any) => {
            const leadPhone = (l.phone || "").replace(/\D/g, "");
            return leadPhone.length >= 4 && normalizedPhone.endsWith(leadPhone);
          });

          if (lead) {
            matchedLeadId = lead.id;

            // Insert interaction for lead timeline
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

            // Update lead state: last_inbound_at, last_activity_at, needs_action
            // Only set needs_action if not already actioned (avoid overwriting existing actions)
            const leadUpdate: Record<string, any> = {
              last_inbound_at: timestamp,
              last_activity_at: timestamp,
            };
            if (!lead.needs_action && lead.next_action_key !== "ooo_return_followup") {
              leadUpdate.needs_action = true;
              leadUpdate.next_action_key = "whatsapp_reply";
              leadUpdate.next_action_label = "Reply via WhatsApp";
            }
            await supabase.from("leads").update(leadUpdate).eq("id", lead.id);
            console.log("[whatsapp-webhook] Updated lead state for:", lead.id);
          }
        }

        // ── Trigger conversation analysis for AI reply suggestions ──
        // Fire-and-forget: don't block the webhook response
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        fetch(`${supabaseUrl}/functions/v1/conversation-analyze`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({ conversation_id: conversationId }),
        }).catch((err) => {
          console.error("[whatsapp-webhook] Failed to trigger conversation-analyze:", err);
        });

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
    JSON.stringify({ ok: true, processed, skipped, statusUpdated }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
});
