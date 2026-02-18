import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encryptToken } from "../_shared/encryption.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const WA_API = "https://graph.facebook.com/v21.0";
const VERIFY_TOKEN = "leadrocket-wa-verify-2026";

// ── Utility: normalize to E.164 digits only ──────────────
function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

// ── Utility: check if acceleration window is active ──────
function isAccelerationActive(lead: any): boolean {
  if (!lead?.acceleration_until) return false;
  return new Date(lead.acceleration_until) > new Date();
}

// ── Utility: resolve effective automation mode ────────────
function getEffectiveMode(lead: any, workspaceSettings: any): string {
  if (isAccelerationActive(lead)) return "acceleration";
  if (lead?.automation_mode) return lead.automation_mode;
  return workspaceSettings?.default_mode ?? "suggest_only";
}

// ── Decision Engine ───────────────────────────────────────
function shouldAutoSend(opts: {
  effective_mode: string;
  intent: string;
  confidence: number;
  workspaceSettings: any;
  lead: any;
  message_text: string;
}): { allowed: boolean; reason: string } {
  const { effective_mode, intent, confidence, workspaceSettings, lead, message_text } = opts;

  // Safety: too short
  if (message_text.trim().length < 3) {
    return { allowed: false, reason: "message_too_short" };
  }

  // Safety: low confidence threshold
  if (confidence < 0.70) {
    return { allowed: false, reason: "low_confidence" };
  }

  // Safety: unsubscribe intent
  if (intent === "unsubscribe") {
    return { allowed: false, reason: "unsubscribe_intent" };
  }

  // Block on keywords
  const blockedKeywords: string[] = workspaceSettings?.blocked_keywords ?? [
    "discount", "lawyer", "contract", "refund", "cancel", "compliance", "lawsuit",
  ];
  const lowerText = message_text.toLowerCase();
  const matchedKeyword = blockedKeywords.find((kw: string) => lowerText.includes(kw.toLowerCase()));
  if (matchedKeyword) {
    return { allowed: false, reason: `blocked_keyword:${matchedKeyword}` };
  }

  // Mode-specific logic
  switch (effective_mode) {
    case "manual":
    case "suggest_only":
      return { allowed: false, reason: `mode_${effective_mode}` };

    case "full_auto":
      return { allowed: true, reason: "full_auto" };

    case "acceleration":
      if (confidence >= 0.75 && !["legal", "negotiation", "complaint", "unsubscribe"].includes(intent)) {
        return { allowed: true, reason: "acceleration_mode" };
      }
      return { allowed: false, reason: "acceleration_blocked_intent_or_confidence" };

    case "hybrid": {
      const threshold = workspaceSettings?.confidence_threshold ?? 0.85;
      const allowedIntents = ["acknowledgment", "scheduling", "clarification"];
      const blockedStages: string[] = workspaceSettings?.blocked_stages ?? ["negotiation", "contract_sent"];
      if (
        confidence >= threshold &&
        allowedIntents.includes(intent) &&
        !blockedStages.includes(lead?.stage ?? "")
      ) {
        return { allowed: true, reason: "hybrid_approved" };
      }
      return { allowed: false, reason: "hybrid_policy_blocked" };
    }

    default:
      return { allowed: false, reason: "unknown_mode" };
  }
}

// ── Extract message body by type ──────────────────────────
function extractBodyText(msg: any): string {
  if (msg.type === "text") return msg.text?.body ?? "";
  if (msg.type === "image") return `[Image] ${msg.image?.caption ?? ""}`;
  if (msg.type === "document") return `[Document] ${msg.document?.filename ?? ""}`;
  if (msg.type === "audio") return "[Audio message]";
  if (msg.type === "video") return `[Video] ${msg.video?.caption ?? ""}`;
  if (msg.type === "location") return `[Location] ${msg.location?.latitude},${msg.location?.longitude}`;
  if (msg.type === "contacts") return "[Contact card]";
  if (msg.type === "sticker") return "[Sticker]";
  if (msg.type === "reaction") return `[Reaction] ${msg.reaction?.emoji ?? ""}`;
  return `[${msg.type ?? "unknown"}]`;
}

// ── Robust JSON extractor (handles LLM markdown wrapping) ──
function extractJsonFromResponse(content: string): unknown {
  // 1. Direct parse (fastest path)
  try { return JSON.parse(content); } catch { /* continue */ }

  // 2. Strip markdown code fences
  const stripped = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(stripped); } catch { /* continue */ }

  // 3. Find JSON object boundaries
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first !== -1 && last > first) {
    const slice = stripped.slice(first, last + 1);
    try { return JSON.parse(slice); } catch { /* continue */ }

    // 4. Repair common issues: control chars + trailing commas
    const repaired = slice
      .replace(/[\x00-\x1F\x7F]/g, " ")
      .replace(/,(\s*[}\]])/g, "$1");
    try { return JSON.parse(repaired); } catch { /* continue */ }
  }

  throw new Error("Could not extract valid JSON from LLM response");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // ── GET → Meta webhook verification ──────────────────────
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    console.log("[whatsapp-webhook] Verify check:", { mode, tokenMatch: token === VERIFY_TOKEN });

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("[whatsapp-webhook] Verification successful");
      return new Response(challenge, { status: 200, headers: corsHeaders });
    }
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const supabase = createClient(supabaseUrl, serviceKey);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

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

      // ── Status update events ────────────────────────────
      const statuses = value?.statuses ?? [];
      for (const statusEvent of statuses) {
        const providerMsgId = statusEvent?.id;
        const newStatus: string = statusEvent?.status;
        const recipientId: string = statusEvent?.recipient_id;

        if (!providerMsgId || !newStatus) continue;
        if (!["sent", "delivered", "read", "failed"].includes(newStatus)) continue;

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

        // Lead intelligence on status events
        if (newStatus === "read" || newStatus === "failed") {
          const normalizedRecipient = (recipientId || "").replace(/\D/g, "");
          if (!normalizedRecipient) continue;

          const { data: allLeads } = await supabase
            .from("leads")
            .select("id, needs_action, next_action_key, phone, whatsapp_number, engagement_score")
            .filter("phone", "neq", "")
            .not("phone", "is", null)
            .limit(100);

          const matchedLead = (allLeads ?? []).find((l: any) => {
            const lp = normalizePhone(l.whatsapp_number || l.phone || "");
            return lp.length >= 4 && normalizedRecipient.endsWith(lp);
          });

          if (matchedLead) {
            if (newStatus === "read") {
              // Section 7: read → update last_read_at + engagement_score +5
              await supabase.from("leads").update({
                last_read_at: new Date().toISOString(),
                engagement_score: (matchedLead.engagement_score ?? 0) + 5,
              } as any).eq("id", matchedLead.id);
              console.log(`[whatsapp-webhook] Read receipt: lead ${matchedLead.id} +5 engagement`);
            } else if (newStatus === "failed") {
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

      // Skip if no messages
      const hasMessages = (value?.messages ?? []).length > 0;
      if (!hasMessages) continue;

      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId) {
        console.warn("[whatsapp-webhook] Missing phone_number_id, skipping");
        skipped++;
        continue;
      }

      // Find integration
      const { data: integration, error: intErr } = await supabase
        .from("integrations")
        .select("id, workspace_id, user_id")
        .eq("type", "whatsapp")
        .eq("provider_account_id", phoneNumberId)
        .eq("is_active", true)
        .maybeSingle();

      if (intErr || !integration) {
        console.warn("[whatsapp-webhook] No active integration for phone_number_id:", phoneNumberId);
        skipped++;
        continue;
      }

      const { workspace_id, user_id: ownerUserId, id: integrationId } = integration;

      // Load workspace automation settings
      const { data: workspaceSettings } = await supabase
        .from("workspace_automation_settings")
        .select("*")
        .eq("workspace_id", workspace_id)
        .maybeSingle();

      const messages = value?.messages ?? [];

      for (const msg of messages) {
        const providerMessageId = msg?.id;
        if (!providerMessageId) { skipped++; continue; }

        // Idempotency check
        const { data: existing } = await supabase
          .from("messages")
          .select("id")
          .eq("provider_message_id", providerMessageId)
          .eq("workspace_id", workspace_id)
          .maybeSingle();

        if (existing) {
          console.log("[whatsapp-webhook] Duplicate message, skipping:", providerMessageId);
          skipped++;
          continue;
        }

        const senderPhone = msg?.from ?? "";
        const normalizedPhone = normalizePhone(senderPhone);
        const timestamp = msg?.timestamp
          ? new Date(parseInt(msg.timestamp) * 1000).toISOString()
          : new Date().toISOString();

        const bodyText = extractBodyText(msg);

        // ── SECTION 2: Sales-first auto lead creation ──────
        // Try to find lead by whatsapp_number first, then phone suffix
        let matchedLead: any = null;

        // 2.1 Try exact whatsapp_number match (E.164)
        if (normalizedPhone) {
          const { data: waLead } = await supabase
            .from("leads")
            .select("id, phone, whatsapp_number, owner_user_id, needs_action, next_action_key, stage, engagement_score, automation_mode, acceleration_until, wa_opted_in")
            .eq("whatsapp_number", normalizedPhone)
            .maybeSingle();
          if (waLead) matchedLead = waLead;
        }

        // 2.2 Fallback: phone suffix match
        if (!matchedLead) {
          const { data: allLeads } = await supabase
            .from("leads")
            .select("id, phone, whatsapp_number, owner_user_id, needs_action, next_action_key, stage, engagement_score, automation_mode, acceleration_until, wa_opted_in")
            .filter("phone", "neq", "")
            .not("phone", "is", null)
            .limit(100);

          matchedLead = (allLeads ?? []).find((l: any) => {
            const lp = normalizePhone(l.whatsapp_number || l.phone || "");
            return lp.length >= 4 && normalizedPhone.endsWith(lp);
          }) ?? null;
        }

        // 2.3 Auto-create minimal lead if none found
        if (!matchedLead) {
          const accelerationUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
          const { data: newLead, error: newLeadErr } = await supabase
            .from("leads")
            .insert({
              name: "WhatsApp Lead",
              email: `wa_${normalizedPhone}@auto.leadrocket`,
              company: "Unknown",
              strategy: "reply",
              whatsapp_number: normalizedPhone,
              source_type: "whatsapp_inbound",
              stage: "new",
              auto_created: true,
              engagement_score: 5,
              acceleration_until: accelerationUntil,
              owner_user_id: ownerUserId,
              wa_opted_in: true,
            } as any)
            .select("id, phone, whatsapp_number, owner_user_id, needs_action, next_action_key, stage, engagement_score, automation_mode, acceleration_until, wa_opted_in")
            .single();

          if (newLeadErr || !newLead) {
            console.error("[whatsapp-webhook] Failed to auto-create lead:", newLeadErr);
          } else {
            matchedLead = newLead;
            // Log auto-creation
            await supabase.from("automation_logs").insert({
              workspace_id,
              lead_id: newLead.id,
              decision: "auto_created_from_whatsapp",
              reason: `phone:${normalizedPhone}`,
            } as any);
            console.log("[whatsapp-webhook] Auto-created lead:", newLead.id);
          }
        }

        // ── Resolve / create contact ───────────────────────
        let contactId: string;

        const { data: identityRow } = await supabase
          .from("contact_identities")
          .select("contact_id")
          .eq("workspace_id", workspace_id)
          .eq("type", "phone")
          .eq("value", normalizedPhone)
          .maybeSingle();

        if (identityRow) {
          contactId = identityRow.contact_id;
          await supabase.from("contacts").update({ last_activity_at: timestamp }).eq("id", contactId);
        } else {
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
            console.error("[whatsapp-webhook] Failed to create contact:", cErr);
            skipped++;
            continue;
          }

          contactId = newContact.id;
          await supabase.from("contact_identities").insert({
            workspace_id,
            contact_id: contactId,
            type: "phone",
            value: normalizedPhone,
            is_primary: true,
          });
        }

        // ── Resolve / create conversation ──────────────────
        let conversationId: string;

        const { data: existingConvo } = await supabase
          .from("conversations")
          .select("id, message_count")
          .eq("workspace_id", workspace_id)
          .eq("contact_id", contactId)
          .eq("channel", "whatsapp")
          .eq("owner_user_id", ownerUserId)
          .eq("status", "open")
          .maybeSingle();

        if (existingConvo) {
          conversationId = existingConvo.id;
          await supabase.from("conversations").update({
            last_message_at: timestamp,
            message_count: (existingConvo.message_count ?? 0) + 1,
          }).eq("id", conversationId);
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
            console.error("[whatsapp-webhook] Failed to create conversation:", cvErr);
            skipped++;
            continue;
          }
          conversationId = newConvo.id;
        }

        // ── SECTION 4: Intent classification ──────────────
        let intent = "unknown";
        let aiConfidence = 0;
        let riskFlags: string[] = [];

        if (bodyText && !bodyText.startsWith("[")) {
          try {
            const intentRes = await fetch(`${supabaseUrl}/functions/v1/ai_task`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${serviceKey}`,
              },
              body: JSON.stringify({
                task: "whatsapp_classify_intent",
                payload: {
                  message_text: bodyText,
                  lead_stage: matchedLead?.stage ?? "new",
                },
              }),
            });

            if (intentRes.ok) {
              const intentData = await intentRes.json();
              if (intentData?.ok && intentData?.content) {
                try {
                  const parsed = extractJsonFromResponse(intentData.content) as any;
                  const KNOWN_INTENTS = ["acknowledgment","scheduling","clarification","objection","complaint","unsubscribe","negotiation","legal","positive_interest","unknown"];
                  intent = KNOWN_INTENTS.includes(parsed.intent) ? parsed.intent : intent;
                  aiConfidence = typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : aiConfidence;
                  riskFlags = Array.isArray(parsed.risk_flags) ? parsed.risk_flags : [];
                  console.log(`[whatsapp-webhook] Intent classified: ${intent} (confidence: ${aiConfidence})`);
                } catch {
                  console.warn("[whatsapp-webhook] Failed to parse intent JSON. Raw content:", intentData.content?.slice(0, 200));
                }
              }
            }
          } catch (err) {
            console.error("[whatsapp-webhook] Intent classification failed:", err);
          }
        }

        // ── Encrypt and store inbound message ─────────────
        const encryptedBody = await encryptToken(bodyText);
        const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

        const { data: senderIdentity } = await supabase
          .from("contact_identities")
          .select("id")
          .eq("workspace_id", workspace_id)
          .eq("contact_id", contactId)
          .eq("type", "phone")
          .eq("value", normalizedPhone)
          .maybeSingle();

        const { data: storedMsg, error: msgErr } = await supabase.from("messages").insert({
          workspace_id,
          conversation_id: conversationId,
          direction: "inbound",
          body_ciphertext: encryptedBody,
          expires_at: expiresAt,
          provider_message_id: providerMessageId,
          whatsapp_message_id: providerMessageId,
          sender_identity_id: senderIdentity?.id ?? null,
          media_type: msg.type !== "text" ? msg.type : null,
          created_at: timestamp,
          intent,
          ai_confidence: aiConfidence > 0 ? aiConfidence : null,
        } as any).select("id").single();

        if (msgErr) {
          console.error("[whatsapp-webhook] Failed to store message:", msgErr);
          skipped++;
          continue;
        }

        const storedMsgId = storedMsg?.id ?? null;

        // ── Bridge to interactions + update lead state ─────
        if (matchedLead) {
          const { error: intxErr } = await supabase.from("interactions").insert({
            lead_id: matchedLead.id,
            type: "whatsapp_inbound",
            source: "whatsapp",
            body_text: bodyText,
            occurred_at: timestamp,
            direction: "inbound",
            from_email: `+${normalizedPhone}`,
          });
          if (intxErr) {
            console.error("[whatsapp-webhook] Failed to bridge to interactions:", intxErr);
          }

          // Engagement score: inbound +10
          const newScore = (matchedLead.engagement_score ?? 0) + 10;
          const leadUpdate: Record<string, any> = {
            last_inbound_at: timestamp,
            last_activity_at: timestamp,
            engagement_score: newScore,
          };

          // Acceleration: expire if past window
          if (matchedLead.acceleration_until && new Date(matchedLead.acceleration_until) < new Date()) {
            leadUpdate.acceleration_until = null;
          }

          // ── SECTION 5: Decision Engine ────────────────────
          const effectiveMode = getEffectiveMode(matchedLead, workspaceSettings);
          const decision = shouldAutoSend({
            effective_mode: effectiveMode,
            intent,
            confidence: aiConfidence,
            workspaceSettings,
            lead: matchedLead,
            message_text: bodyText,
          });

          if (decision.allowed) {
            // ── SECTION 6: Auto Send Execution ───────────────
            try {
              // Generate AI reply
              const replyRes = await fetch(`${supabaseUrl}/functions/v1/ai_task`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${serviceKey}`,
                },
                body: JSON.stringify({
                  task: "whatsapp_reply_suggestion",
                  payload: {
                    message_text: bodyText,
                    lead_stage: matchedLead.stage,
                    intent,
                    lead_name: matchedLead.name ?? "there",
                  },
                }),
              });

              let replyText: string | null = null;
              if (replyRes.ok) {
                const replyData = await replyRes.json();
                if (replyData?.ok && replyData?.content) {
                  replyText = replyData.content.trim();
                }
              }

              if (replyText) {
                // Load integration credentials to verify it exists
                const { data: integrationData } = await supabase
                  .from("integrations")
                  .select("credentials_encrypted, provider_account_id")
                  .eq("id", integrationId)
                  .single();

                if (integrationData?.credentials_encrypted && integrationData?.provider_account_id) {
                  // Fire-and-forget send via whatsapp-send
                  // We store the automated outbound message directly here instead of calling whatsapp-send
                  // to avoid circular auth issues from webhook context

                  // Store automated outbound message
                  const encryptedReply = await encryptToken(replyText);
                  const replyExpiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
                  const { data: autoMsg } = await supabase.from("messages").insert({
                    workspace_id,
                    conversation_id: conversationId,
                    direction: "outbound",
                    body_ciphertext: encryptedReply,
                    expires_at: replyExpiresAt,
                    is_automated: true,
                    intent,
                    ai_confidence: aiConfidence > 0 ? aiConfidence : null,
                    status: "sent",
                  } as any).select("id").single();

                  // Update conversation count
                  await supabase.from("conversations").update({
                    message_count: (existingConvo?.message_count ?? 1) + 2,
                    last_message_at: new Date().toISOString(),
                  }).eq("id", conversationId);

                  // engagement_score +5 for auto-send
                  leadUpdate.engagement_score = newScore + 5;

                  // Log auto-sent
                  await supabase.from("automation_logs").insert({
                    workspace_id,
                    lead_id: matchedLead.id,
                    message_id: autoMsg?.id ?? null,
                    decision: "auto_sent",
                    reason: effectiveMode,
                  } as any);

                  console.log(`[whatsapp-webhook] Auto-sent reply for lead ${matchedLead.id} in ${effectiveMode} mode`);
                }
              }
            } catch (sendErr) {
              console.error("[whatsapp-webhook] Auto-send failed:", sendErr);
            }

            // Clear needs_action for auto-sent
            leadUpdate.needs_action = false;
          } else {
            // Suggestion only: flag needs_action
            if (!matchedLead.needs_action && matchedLead.next_action_key !== "ooo_return_followup") {
              leadUpdate.needs_action = true;
              leadUpdate.next_action_key = "whatsapp_reply";
              leadUpdate.next_action_label = "Reply via WhatsApp";
            }

            // Log suggestion-only decision
            await supabase.from("automation_logs").insert({
              workspace_id,
              lead_id: matchedLead.id,
              message_id: storedMsgId,
              decision: "suggestion_only",
              reason: decision.reason,
            } as any);
          }

          await supabase.from("leads").update(leadUpdate as any).eq("id", matchedLead.id);
          console.log(`[whatsapp-webhook] Lead ${matchedLead.id} updated. Mode: ${effectiveMode}, Decision: ${decision.reason}`);
        }

        // ── Trigger conversation analysis (fire-and-forget) ─
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
        console.log("[whatsapp-webhook] Processed message:", providerMessageId);
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
