// ============================================================
// whatsapp-events-processor
//
// Async processor that consumes channel_events rows and
// executes all WhatsApp business logic:
//   - Contact + conversation provisioning
//   - Message storage (encrypted)
//   - Lead matching / auto-creation
//   - AI intent classification
//   - Automated reply decision engine
//   - Status update application
//   - Lead timeline bridging
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encryptToken } from "../_shared/encryption.ts";
import { WhatsAppService } from "../_shared/whatsapp/service.ts";
import { projectTimelineItem, whatsappDedupeKey } from "../_shared/timelineProjector.ts";
import { createCanonicalInteraction } from "../_shared/canonicalInteraction.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 5;

// ── Helpers ─────────────────────────────────────────────────

function normalizePhone(raw: string): string {
  return (raw ?? "").replace(/\D/g, "");
}

function isAccelerationActive(lead: any): boolean {
  if (!lead?.acceleration_until) return false;
  return new Date(lead.acceleration_until) > new Date();
}

function getEffectiveMode(lead: any, workspaceSettings: any): string {
  if (isAccelerationActive(lead)) return "acceleration";
  if (lead?.automation_mode) return lead.automation_mode;
  return workspaceSettings?.default_mode ?? "suggest_only";
}

function isWeekend(date: Date, tz: string): boolean {
  try {
    const dayStr = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(date);
    return dayStr === "Sat" || dayStr === "Sun";
  } catch {
    const utcDay = date.getUTCDay();
    return utcDay === 0 || utcDay === 6;
  }
}

function isAfterHours(date: Date, tz: string): boolean {
  try {
    const hourStr = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(date);
    const hour = parseInt(hourStr, 10);
    return hour < 8 || hour >= 20; // before 8am or after 8pm
  } catch {
    const utcHour = date.getUTCHours();
    return utcHour < 8 || utcHour >= 20;
  }
}

function shouldAutoSend(opts: {
  effective_mode: string;
  intent: string;
  confidence: number;
  workspaceSettings: any;
  lead: any;
  message_text: string;
  timezone?: string;
}): { allowed: boolean; reason: string } {
  const { effective_mode, intent, confidence, workspaceSettings, lead, message_text, timezone } = opts;

  if (message_text.trim().length < 3) return { allowed: false, reason: "message_too_short" };
  if (confidence < 0.70) return { allowed: false, reason: "low_confidence" };
  if (intent === "unsubscribe") return { allowed: false, reason: "unsubscribe_intent" };

  const blockedKeywords: string[] = workspaceSettings?.blocked_keywords ?? [
    "discount", "lawyer", "contract", "refund", "cancel", "compliance", "lawsuit",
  ];
  const lowerText = message_text.toLowerCase();
  const matchedKeyword = blockedKeywords.find((kw: string) => lowerText.includes(kw.toLowerCase()));
  if (matchedKeyword) return { allowed: false, reason: `blocked_keyword:${matchedKeyword}` };

  // ── Time-based restrictions ───────────────────────────────
  // Only enforce when the mode would actually auto-send
  const wouldAutoSend = !["manual", "suggest_only"].includes(effective_mode);
  if (wouldAutoSend) {
    const tz = timezone || "UTC";
    const now = new Date();

    if (!workspaceSettings?.weekend_auto && isWeekend(now, tz)) {
      return { allowed: false, reason: "weekend_blocked" };
    }

    if (!workspaceSettings?.after_hours_auto && isAfterHours(now, tz)) {
      return { allowed: false, reason: "after_hours_blocked" };
    }
  }

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

function extractJsonFromResponse(content: string): unknown {
  try { return JSON.parse(content); } catch { /* continue */ }
  const stripped = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(stripped); } catch { /* continue */ }
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first !== -1 && last > first) {
    const slice = stripped.slice(first, last + 1);
    try { return JSON.parse(slice); } catch { /* continue */ }
    const repaired = slice.replace(/[\x00-\x1F\x7F]/g, " ").replace(/,(\s*[}\]])/g, "$1");
    try { return JSON.parse(repaired); } catch { /* continue */ }
  }
  throw new Error("Could not extract valid JSON from LLM response");
}

// ============================================================
// Process a single inbound_message event
// ============================================================

async function processInboundMessage(
  supabase: any,
  event: any,
): Promise<void> {
  const norm = event.payload_normalized;
  const workspaceId = event.workspace_id;
  const senderPhone = norm.from ?? "";
  const normalizedPhone = normalizePhone(senderPhone);
  const bodyText = norm.text ?? "";
  const timestamp = norm.timestamp ?? new Date().toISOString();
  const providerMessageId = norm.external_message_id ?? event.provider_event_id;
  const phoneNumberId = norm.to ?? "";

  // ── Resolve integration for this workspace ────────────────
  const { data: integration } = await supabase
    .from("integrations")
    .select("id, workspace_id, user_id")
    .eq("type", "whatsapp")
    .eq("provider", norm.provider)
    .eq("is_active", true)
    .eq("provider_account_id", phoneNumberId)
    .maybeSingle();

  const ownerUserId = integration?.user_id ?? null;
  const integrationId = integration?.id ?? null;

  if (!ownerUserId) {
    throw new Error(`No owner found for phone_number_id=${phoneNumberId}`);
  }

  // ── Load workspace automation settings ────────────────────
  const { data: workspaceSettings } = await supabase
    .from("workspace_automation_settings")
    .select("*")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  // ── Idempotency check on messages table ───────────────────
  const { data: existingMsg } = await supabase
    .from("messages")
    .select("id")
    .eq("provider_message_id", providerMessageId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (existingMsg) {
    console.log("[processor] Message already stored, skipping:", providerMessageId);
    return;
  }

  // ── Lead matching (workspace-scoped) ───────────────────────
  let matchedLead: any = null;
  const leadSelectCols = "id, phone, whatsapp_number, owner_user_id, needs_action, next_action_key, stage, engagement_score, automation_mode, acceleration_until, wa_opted_in";

  // Strategy 1: Exact whatsapp_number match within workspace
  if (normalizedPhone) {
    const { data: waLeads } = await supabase
      .from("leads")
      .select(leadSelectCols)
      .eq("whatsapp_number", normalizedPhone)
      .limit(10);

    // Filter to workspace members only (leads don't have workspace_id, so check owner membership)
    if (waLeads?.length) {
      const ownerIds = [...new Set(waLeads.map((l: any) => l.owner_user_id))];
      const { data: members } = await supabase
        .from("workspace_members")
        .select("user_id")
        .eq("workspace_id", workspaceId)
        .in("user_id", ownerIds);
      const memberSet = new Set((members ?? []).map((m: any) => m.user_id));
      const workspaceLeads = waLeads.filter((l: any) => memberSet.has(l.owner_user_id));
      if (workspaceLeads.length === 1) {
        matchedLead = workspaceLeads[0];
      } else if (workspaceLeads.length > 1) {
        // Ambiguous — don't match
        console.warn(`[processor] Ambiguous whatsapp_number match: ${workspaceLeads.length} leads for ${normalizedPhone}`);
      }
    }
  }

  // Strategy 2: Fallback phone/whatsapp suffix match within workspace
  if (!matchedLead && normalizedPhone) {
    // Get all workspace member user_ids first
    const { data: wsMembers } = await supabase
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId);
    const wsMemberIds = (wsMembers ?? []).map((m: any) => m.user_id);

    if (wsMemberIds.length > 0) {
      const { data: candidateLeads } = await supabase
        .from("leads")
        .select(leadSelectCols)
        .in("owner_user_id", wsMemberIds)
        .or("phone.neq.,whatsapp_number.neq.")
        .limit(200);

      const matches = (candidateLeads ?? []).filter((l: any) => {
        const lp = normalizePhone(l.whatsapp_number || l.phone || "");
        return lp.length >= 4 && normalizedPhone.endsWith(lp);
      });

      if (matches.length === 1) {
        matchedLead = matches[0];
      } else if (matches.length > 1) {
        console.warn(`[processor] Ambiguous phone suffix match: ${matches.length} leads for ${normalizedPhone}`);
      }
    }
  }

  // Auto-create minimal lead if none found
  if (!matchedLead) {
    if (!workspaceId) {
      console.warn("[processor] Cannot auto-create lead: no workspace_id on event");
      await supabase.from("automation_logs").insert({
        workspace_id: workspaceId || "00000000-0000-0000-0000-000000000000",
        decision: "lead_creation_skipped",
        reason: `no_workspace_id for phone:${normalizedPhone}`,
      } as any);
    } else {
      const accelerationUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const { data: newLead, error: newLeadErr } = await supabase
        .from("leads")
        .insert({
          name: "WhatsApp Lead",
          email: `wa_${normalizedPhone}@auto.leadrocket`,
          company: "Unknown",
          strategy: "fast",
          whatsapp_number: normalizedPhone,
          source_type: "whatsapp_inbound",
          stage: "new",
          auto_created: true,
          engagement_score: 5,
          acceleration_until: accelerationUntil,
          owner_user_id: ownerUserId,
          workspace_id: workspaceId,
          wa_opted_in: true,
        } as any)
        .select(leadSelectCols)
        .single();

      if (newLeadErr || !newLead) {
        console.error("[processor] Failed to auto-create lead:", newLeadErr);
      } else {
        matchedLead = newLead;
        await supabase.from("automation_logs").insert({
          workspace_id: workspaceId,
          lead_id: newLead.id,
          decision: "auto_created_from_whatsapp",
          reason: `phone:${normalizedPhone}`,
        } as any);
        console.log("[processor] Auto-created lead:", newLead.id);
      }
    }
  }

  // ── Contact provisioning ──────────────────────────────────
  let contactId: string;

  const { data: identityRow } = await supabase
    .from("contact_identities")
    .select("contact_id")
    .eq("workspace_id", workspaceId)
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
        workspace_id: workspaceId,
        status: "unclassified",
        display_name: `+${normalizedPhone}`,
        last_activity_at: timestamp,
      })
      .select("id")
      .single();

    if (cErr || !newContact) {
      throw new Error(`Failed to create contact: ${cErr?.message}`);
    }

    contactId = newContact.id;
    await supabase.from("contact_identities").insert({
      workspace_id: workspaceId,
      contact_id: contactId,
      type: "phone",
      value: normalizedPhone,
      is_primary: true,
    });
  }

  // ── Persist contact→lead link safely ──────────────────────
  if (matchedLead && contactId) {
    try {
      const { data: currentContact } = await supabase
        .from("contacts")
        .select("lead_id")
        .eq("id", contactId)
        .single();

      if (!currentContact?.lead_id) {
        // Safe to set — no existing link
        await supabase.from("contacts")
          .update({ lead_id: matchedLead.id })
          .eq("id", contactId);
        console.log(`[processor] Linked contact ${contactId} → lead ${matchedLead.id}`);
      } else if (currentContact.lead_id !== matchedLead.id) {
        // Conflict — log but do NOT overwrite
        console.warn(`[processor] Contact ${contactId} already linked to lead ${currentContact.lead_id}, matched ${matchedLead.id}`);
        await supabase.from("automation_logs").insert({
          workspace_id: workspaceId,
          lead_id: matchedLead.id,
          decision: "lead_contact_conflict",
          reason: `contact=${contactId} existing_lead=${currentContact.lead_id} matched_lead=${matchedLead.id}`,
        } as any).then(() => {}).catch(() => {});
      }
    } catch (linkErr: any) {
      console.warn("[processor] Non-blocking contact→lead link failed:", linkErr.message);
    }
  }

  // ── Conversation provisioning ─────────────────────────────
  let conversationId: string;

  const { data: existingConvo } = await supabase
    .from("conversations")
    .select("id, message_count")
    .eq("workspace_id", workspaceId)
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
        workspace_id: workspaceId,
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
      throw new Error(`Failed to create conversation: ${cvErr?.message}`);
    }
    conversationId = newConvo.id;
  }

  // ── Store inbound message (encrypted) ─────────────────────
  const encryptedBody = await encryptToken(bodyText);
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

  // Find sender identity for this contact
  const { data: senderIdentity } = await supabase
    .from("contact_identities")
    .select("id")
    .eq("contact_id", contactId)
    .eq("type", "phone")
    .eq("value", normalizedPhone)
    .maybeSingle();

  await supabase.from("messages").insert({
    workspace_id: workspaceId,
    conversation_id: conversationId,
    direction: "inbound",
    body_ciphertext: encryptedBody,
    expires_at: expiresAt,
    provider_message_id: providerMessageId,
    sender_identity_id: senderIdentity?.id ?? null,
    whatsapp_message_id: providerMessageId,
    created_at: timestamp,
    media_type: norm.message_type !== "text" ? norm.message_type : null,
  });

  // ── Bridge to lead interactions timeline ──────────────────
  if (matchedLead) {
    try {
      const waResult = await createCanonicalInteraction(supabase, {
        lead_id: matchedLead.id,
        type: "whatsapp_inbound",
        source: "whatsapp",
        body_text: bodyText,
        occurred_at: timestamp,
        direction: "inbound",
        from_email: `+${normalizedPhone}`,
        workspace_id: workspaceId,
        contact_id: contactId,
        conversation_id: conversationId,
        provider: (norm as any).provider || "meta",
        metadata_json: { from_phone: `+${normalizedPhone}`, provider_message_id: providerMessageId },
        dedupe_key: whatsappDedupeKey("inbound", providerMessageId, `${matchedLead.id}:${timestamp}`),
      });

      if (waResult.error && waResult.error !== "duplicate") {
        console.warn("[whatsapp-events-processor] Canonical interaction failed:", waResult.error);
      }
    } catch (err: any) {
      console.warn("[whatsapp-events-processor] Non-blocking interaction insert failed:", err.message);
    }

    // Update lead activity
    await supabase.from("leads").update({
      last_activity_at: timestamp,
      last_inbound_at: timestamp,
      engagement_score: (matchedLead.engagement_score ?? 0) + 10,
      wa_opted_in: true,
      needs_action: true,
      next_action_key: "whatsapp_reply",
      next_action_label: "Reply to WhatsApp message",
    } as any).eq("id", matchedLead.id);
  }

  // ── AI Classification + Automated Reply ───────────────────
  if (!matchedLead || !matchedLead.wa_opted_in) {
    console.log("[processor] Skipping AI: no matched lead or not opted in");
    return;
  }

  // Only classify text messages
  if (norm.message_type !== "text" || !bodyText || bodyText.startsWith("[")) {
    console.log("[processor] Skipping AI: non-text message type");
    return;
  }

  try {
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!lovableApiKey) {
      console.warn("[processor] LOVABLE_API_KEY not set, skipping AI classification");
      return;
    }

    // Load rep profile for context
    const { data: repProfile } = await supabase
      .from("rep_profiles")
      .select("full_name, company_name")
      .eq("user_id", ownerUserId)
      .maybeSingle();

    const { data: workspaceProfile } = await supabase
      .from("workspace_profiles")
      .select("product_name, product_description, primary_value_props, disallowed_topics, pricing_policy, meeting_timezone")
      .eq("user_id", ownerUserId)
      .maybeSingle();

    const systemPrompt = `You are an AI sales assistant. Analyze the inbound WhatsApp message and return JSON with exactly these fields:
{
  "intent": one of ["greeting","question","objection","acknowledgment","scheduling","clarification","complaint","legal","negotiation","unsubscribe","out_of_office","other"],
  "confidence": float 0-1,
  "suggested_reply": string (a brief, helpful reply suitable for WhatsApp),
  "reasoning": string (1-2 sentences explaining your classification)
}

Context:
- Rep: ${repProfile?.full_name ?? "Sales Rep"} at ${repProfile?.company_name ?? workspaceProfile?.product_name ?? "the company"}
- Product: ${workspaceProfile?.product_description ?? "Not specified"}
- Lead stage: ${matchedLead.stage}
- Disallowed topics: ${(workspaceProfile?.disallowed_topics ?? []).join(", ") || "none"}
- Pricing policy: ${workspaceProfile?.pricing_policy ?? "do not discuss pricing"}`;

    const aiResponse = await fetch("https://ai.lovable.dev/api/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lovableApiKey}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: bodyText },
        ],
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      console.error("[processor] AI classification failed:", aiResponse.status, errText);
      return;
    }

    const aiData = await aiResponse.json();
    const rawContent = aiData?.choices?.[0]?.message?.content ?? "";
    const parsed = extractJsonFromResponse(rawContent) as any;

    const intent: string = parsed?.intent ?? "other";
    const confidence: number = parsed?.confidence ?? 0;
    const suggestedReply: string = parsed?.suggested_reply ?? "";

    // Update message with AI classification
    await supabase.from("messages").update({
      intent,
      ai_confidence: confidence,
    }).eq("provider_message_id", providerMessageId).eq("workspace_id", workspaceId);

    console.log(`[processor] AI classified: intent=${intent} confidence=${confidence}`);

    // ── Automation decision ────────────────────────────────
    const effectiveMode = getEffectiveMode(matchedLead, workspaceSettings);
    const decision = shouldAutoSend({
      effective_mode: effectiveMode,
      intent,
      confidence,
      workspaceSettings,
      lead: matchedLead,
      message_text: bodyText,
      timezone: workspaceProfile?.meeting_timezone ?? undefined,
    });

    // Log the decision
    await supabase.from("automation_logs").insert({
      workspace_id: workspaceId,
      lead_id: matchedLead.id,
      message_id: null,
      decision: decision.allowed ? "auto_sent" : "blocked",
      reason: decision.reason,
    } as any);

    if (!decision.allowed) {
      // Store as a draft for manual review
      if (suggestedReply) {
        await supabase.from("drafts").insert({
          lead_id: matchedLead.id,
          channel: "whatsapp",
          draft_type: "ai_suggested",
          body_text: suggestedReply,
          to_recipient: normalizedPhone,
          created_by: ownerUserId,
        });
        console.log(`[processor] Draft saved for lead ${matchedLead.id}: ${decision.reason}`);
      }
      return;
    }

    // ── Auto-send reply via provider abstraction ─────────
    if (!suggestedReply) {
      console.log("[processor] Auto-send approved but no suggested reply");
      return;
    }

    if (!integrationId) {
      console.error("[processor] No integration for auto-send");
      return;
    }

    const svc = await WhatsAppService.forIntegration(supabase, integrationId);
    const sendResult = await svc.sendMessage({ to: normalizedPhone, body: suggestedReply });
    const replyMsgId = sendResult.providerMessageId;

    // Store outbound message
    const encryptedReply = await encryptToken(suggestedReply);
    const replyExpiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    await supabase.from("messages").insert({
      workspace_id: workspaceId,
      conversation_id: conversationId,
      direction: "outbound",
      body_ciphertext: encryptedReply,
      expires_at: replyExpiresAt,
      provider_message_id: replyMsgId,
      is_automated: true,
      created_at: now,
      intent,
      ai_confidence: confidence,
    });

    // Update conversation
    const { data: updatedConvo } = await supabase
      .from("conversations")
      .select("message_count")
      .eq("id", conversationId)
      .single();

    await supabase.from("conversations").update({
      message_count: (updatedConvo?.message_count ?? 0) + 1,
      last_message_at: now,
    }).eq("id", conversationId);

    // Bridge outbound to lead timeline
    try {
      await supabase.from("interactions").insert({
        lead_id: matchedLead.id,
        type: "whatsapp_outbound",
        source: "whatsapp",
        body_text: suggestedReply,
        occurred_at: now,
        direction: "outbound",
        ai_intent: intent,
        ai_summary: `Auto-reply (${decision.reason})`,
      });
    } catch (err: any) {
      console.warn("[whatsapp-events-processor] Non-blocking outbound interaction insert failed:", err.message);
    }

    // Update lead
    await supabase.from("leads").update({
      last_outbound_at: now,
      last_activity_at: now,
      needs_action: false,
      next_action_key: null,
      next_action_label: null,
    } as any).eq("id", matchedLead.id);

    console.log(`[processor] Auto-sent reply via ${svc.providerType} to ${normalizedPhone}: ${replyMsgId}`);

  } catch (aiErr: any) {
    console.error("[processor] AI/automation error:", aiErr.message);
    // Non-fatal: message is already stored, just skip automation
  }
}

// ============================================================
// Process a single status_update event
// ============================================================

async function processStatusUpdate(
  supabase: any,
  event: any,
): Promise<void> {
  const norm = event.payload_normalized;
  const providerMsgId = norm.external_message_id ?? "";
  const newStatus = norm.status ?? "";

  if (!providerMsgId || !newStatus) {
    throw new Error("Missing provider_message_id or status");
  }

  // Update message status
  const { error: statusErr } = await supabase
    .from("messages")
    .update({ status: newStatus })
    .eq("provider_message_id", providerMsgId);

  if (statusErr) {
    console.error("[processor] Failed to update message status:", statusErr.message);
  }

  console.log(`[processor] Status: ${providerMsgId} → ${newStatus}`);

  // Lead intelligence for read/failed
  if (newStatus === "read" || newStatus === "failed") {
    const recipientId = norm.recipient_id ?? "";
    if (!recipientId) return;

    const { data: allLeads } = await supabase
      .from("leads")
      .select("id, needs_action, next_action_key, phone, whatsapp_number, engagement_score")
      .filter("phone", "neq", "")
      .not("phone", "is", null)
      .limit(100);

    const matchedLead = (allLeads ?? []).find((l: any) => {
      const lp = normalizePhone(l.whatsapp_number || l.phone || "");
      return lp.length >= 4 && recipientId.endsWith(lp);
    });

    if (!matchedLead) return;

    if (newStatus === "read") {
      await supabase.from("leads").update({
        last_read_at: new Date().toISOString(),
        engagement_score: (matchedLead.engagement_score ?? 0) + 5,
      } as any).eq("id", matchedLead.id);
      console.log(`[processor] Read receipt: lead ${matchedLead.id} +5 engagement`);
    } else if (newStatus === "failed") {
      if (!matchedLead.needs_action || matchedLead.next_action_key === "whatsapp_reply") {
        await supabase.from("leads").update({
          needs_action: true,
          next_action_key: "whatsapp_failed",
          next_action_label: "WhatsApp message failed — retry",
        } as any).eq("id", matchedLead.id);
        console.log(`[processor] Flagged failed delivery for lead ${matchedLead.id}`);
      }
    }
  }
}

// ============================================================
// Main handler
// ============================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── Fetch unprocessed events ──────────────────────────────
  const { data: events, error: fetchErr } = await supabase
    .from("channel_events")
    .select("*")
    .eq("channel", "whatsapp")
    .is("processed_at", null)
    .lt("attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchErr) {
    console.error("[processor] Failed to fetch events:", fetchErr.message);
    return new Response(JSON.stringify({ error: "Failed to fetch events" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!events || events.length === 0) {
    return new Response(JSON.stringify({ ok: true, processed: 0 }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let processed = 0;
  let failed = 0;

  for (const event of events) {
    try {
      // Skip events with no workspace
      if (!event.workspace_id) {
        await supabase.from("channel_events").update({
          processed_at: new Date().toISOString(),
          last_error: "workspace_not_found",
        }).eq("id", event.id);
        processed++;
        continue;
      }

      if (event.event_type === "inbound_message") {
        await processInboundMessage(supabase, event);
      } else if (event.event_type === "status_update") {
        await processStatusUpdate(supabase, event);
      } else {
        console.warn(`[processor] Unknown event_type: ${event.event_type}`);
      }

      // Mark success
      await supabase.from("channel_events").update({
        processed_at: new Date().toISOString(),
        last_error: null,
      }).eq("id", event.id);

      processed++;
    } catch (err: any) {
      const newAttempts = (event.attempts ?? 0) + 1;
      const isDead = newAttempts >= MAX_ATTEMPTS;

      await supabase.from("channel_events").update({
        attempts: newAttempts,
        last_error: isDead ? `dead_letter:${err.message}` : err.message,
        processed_at: isDead ? new Date().toISOString() : null,
      }).eq("id", event.id);

      console.error(`[processor] Event ${event.id} failed (attempt ${newAttempts}):`, err.message);
      failed++;
    }
  }

  console.log(`[processor] Batch complete: ${processed} processed, ${failed} failed, ${events.length} total`);

  return new Response(
    JSON.stringify({ ok: true, processed, failed, total: events.length }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
