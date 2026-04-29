// ============================================================
// POST /outlook-send
//
// Body: { mail_account_id, to, subject, bodyHtml, threadId?,
//         leadId?, draftId?, skipStateUpdate?, ownerUserId? }
//
// Mirrors gmail-send: post-send interaction recording, lead state
// updates, AI analysis, 404 retry, and needsReconnect flag.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isInternalCaller } from "../_shared/authz.ts";
import { getFreshOutlookToken } from "../_shared/outlookTokens.ts";
import { logger } from "../_shared/logger.ts";
import { projectTimelineItem, emailDedupeKey } from "../_shared/timelineProjector.ts";
import { loadDealMemory, updateFromOutboundLite, saveDealMemory } from "../_shared/dealMemory.ts";

function corsHeaders(origin: string): Record<string, string> {
  const allowed =
    origin.includes("localhost") ||
    origin.endsWith(".lovableproject.com") ||
    origin.endsWith(".lovable.app") ||
    origin === "https://drivepilot.app" ||
    origin === "https://www.drivepilot.app";
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

// Strip HTML tags for plain-text body_text in interactions
function htmlToPlainText(html: string): string {
  let text = html;
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;/gi, " ");
  text = text.replace(/&amp;/gi, "&");
  text = text.replace(/&lt;/gi, "<");
  text = text.replace(/&gt;/gi, ">");
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  text = text.replace(/\s+/g, " ");
  return text.trim();
}

serve(async (req) => {
  const origin = req.headers.get("Origin") ?? "";
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const isInternal = isInternalCaller(req);

    // Parse body first (req.json() can only be called once)
    const body = await req.json();
    const { mail_account_id, to, subject, bodyHtml, threadId, leadId, draftId, skipStateUpdate, ownerUserId } = body;

    // Auth check
    let userId: string;
    if (isInternal) {
      if (!ownerUserId) {
        return new Response(JSON.stringify({ ok: false, error: "Internal calls require ownerUserId" }), {
          status: 400,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      userId = ownerUserId;
    } else {
      const userClient = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      // Fix: use getUser() without arguments — the JWT is already in the Authorization header
      const { data: { user }, error: authError } = await userClient.auth.getUser();
      if (authError || !user) {
        return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
          status: 401,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      userId = user.id;
    }

    if (!mail_account_id || !to || !subject || !bodyHtml) {
      return new Response(
        JSON.stringify({ ok: false, error: "mail_account_id, to, subject, bodyHtml are required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    // --- Validate mailbox access ---
    const { data: accountData, error: accountErr } = await serviceClient
      .from("mail_accounts")
      .select("email_address, workspace_id")
      .eq("id", mail_account_id)
      .single();

    if (accountErr || !accountData) {
      logger.error("mail.outlook.account_not_found", { mail_account_id, userId });
      return new Response(
        JSON.stringify({ ok: false, error: "Mail account not found" }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const { data: membership } = await serviceClient
      .from("workspace_members")
      .select("id")
      .eq("workspace_id", accountData.workspace_id)
      .eq("user_id", userId)
      .maybeSingle();

    if (!membership) {
      logger.error("mail.outlook.unauthorized_mail_account", {
        mail_account_id,
        workspace_id: accountData.workspace_id,
        userId,
      });
      return new Response(
        JSON.stringify({ ok: false, error: "Unauthorized mail account" }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // --- Validate lead ownership ---
    if (leadId) {
      const { data: leadOwner, error: leadOwnerErr } = await serviceClient
        .from("leads")
        .select("owner_user_id")
        .eq("id", leadId)
        .single();

      if (leadOwnerErr || !leadOwner) {
        logger.error("mail.outlook.lead_not_found", { leadId, userId });
        return new Response(
          JSON.stringify({ ok: false, error: "Lead not found" }),
          { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }

      if (leadOwner.owner_user_id !== userId) {
        logger.error("mail.outlook.lead_ownership_mismatch", {
          leadId,
          requestUserId: userId,
          actualOwnerId: leadOwner.owner_user_id,
        });
        return new Response(
          JSON.stringify({ ok: false, error: "Lead ownership mismatch" }),
          { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
        );
      }
    }

    const accountEmail = accountData.email_address || "";

    // Auto-refresh token (throws + marks expired if refresh fails)
    let accessToken: string;
    try {
      accessToken = await getFreshOutlookToken(mail_account_id, serviceClient);
    } catch (tokenErr) {
      const errMsg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
      const needsReconnect = errMsg.includes("expired") || errMsg.includes("reauthorize") || errMsg.includes("refresh failed");
      return new Response(
        JSON.stringify({
          ok: false,
          error: needsReconnect
            ? "Outlook permissions need updating - please reauthorize Outlook in Settings"
            : errMsg,
          needsReconnect,
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // Build Graph sendMail payload
    let sendUrl = "https://graph.microsoft.com/v1.0/me/sendMail";
    let sendPayload: Record<string, unknown> = {
      message: {
        subject,
        body: { contentType: "HTML", content: bodyHtml },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    };

    // Graph message IDs are long (typically 100+ chars, start with "AAMkA").
    // ConversationIds are shorter (~30 chars). /reply only accepts message IDs —
    // passing a conversationId returns 400 "ConversationId isn't supported".
    const looksLikeGraphMessageId = !!threadId && threadId.length > 80 && threadId.startsWith("AAMk");

    if (threadId && looksLikeGraphMessageId) {
      // threadId is a Graph message ID — safe to use /reply
      sendUrl = `https://graph.microsoft.com/v1.0/me/messages/${threadId}/reply`;
      sendPayload = {
        message: {
          body: { contentType: "HTML", content: bodyHtml },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        comment: "",
      };
    } else if (threadId) {
      logger.info("mail.outlook.thread_id_not_message_id_fallback", {
        mail_account_id,
        thread_id_len: threadId.length,
      });
    }

    let sendResp = await fetch(sendUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sendPayload),
    });

    // Retry as fresh email when:
    // - 404: thread/message was deleted
    // - 400 ConversationId: threadId was a conversationId, not a message ID
    const shouldRetryFresh =
      !sendResp.ok &&
      threadId &&
      (sendResp.status === 404 ||
        (sendResp.status === 400 &&
          (await sendResp.clone().text()).includes("ConversationId")));

    if (shouldRetryFresh) {
      logger.info("mail.outlook.thread_retry_as_fresh", {
        mail_account_id,
        thread_id: threadId,
        original_status: sendResp.status,
      });
      const retryPayload = {
        message: {
          subject,
          body: { contentType: "HTML", content: bodyHtml },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: true,
      };
      sendResp = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(retryPayload),
      });
    }

    if (!sendResp.ok) {
      const errText = await sendResp.text();
      logger.error("mail.outlook.send_failed", {
        mail_account_id,
        status: sendResp.status,
        error: errText,
      });

      const needsReconnect =
        sendResp.status === 401 ||
        sendResp.status === 403 ||
        errText.includes("InvalidAuthenticationToken") ||
        errText.includes("CompactToken") ||
        errText.includes("TokenExpired");

      return new Response(
        JSON.stringify({
          ok: false,
          error: needsReconnect
            ? "Outlook permissions need updating - please reauthorize Outlook in Settings"
            : `Graph sendMail failed (${sendResp.status})`,
          detail: errText,
          needsReconnect,
        }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // 202 Accepted = success (no body from Graph sendMail)
    logger.info("mail.outlook.email_sent", {
      mail_account_id,
      to,
      subject,
      has_thread: !!threadId,
      has_lead: !!leadId,
    });

    // Update last_sync_at
    await serviceClient
      .from("mail_accounts")
      .update({ last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", mail_account_id);

    // --- Post-send logic (mirrors gmail-send) ---
    const backgroundTasks = async () => {
      try {
        if (leadId) {
          const bodyPlainText = htmlToPlainText(bodyHtml);
          const interactionOccurredAt = new Date().toISOString();

          // Create interaction record
          const { data: interactionRow } = await serviceClient
            .from("interactions")
            .insert({
              lead_id: leadId,
              type: "email_outbound",
              source: "outlook",
              occurred_at: interactionOccurredAt,
              subject,
              from_email: accountEmail,
              to_email: to,
              // Phase 1: single recipient → one-element to_emails array.
              // PR 1.2 will pass full multi-recipient arrays through.
              to_emails: [to],
              cc_emails: [],
              body_text: bodyPlainText.substring(0, 10000),
              direction: "outbound",
            })
            .select("id")
            .single();

          // Project to unified timeline
          if (interactionRow) {
            projectTimelineItem(serviceClient, {
              workspace_id: accountData.workspace_id,
              lead_id: leadId,
              channel: "email",
              provider: "outlook",
              direction: "outbound",
              event_type: "email_outbound",
              occurred_at: interactionOccurredAt,
              source_table: "interactions",
              source_id: interactionRow.id,
              snippet_text: bodyPlainText?.substring(0, 500),
              subject,
              metadata_json: { from_email: accountEmail, to_email: to, to_emails: [to], cc_emails: [] },
              dedupe_key: emailDedupeKey("outlook", null, interactionRow.id),
            }).catch(e => logger.warn("mail.outlook.timeline_projection_failed", { error: String(e) }));
          }

          // Get current lead data
          const { data: leadData, error: leadError } = await serviceClient
            .from("leads")
            .select("stage, next_action_key, next_action_label, company, name")
            .eq("id", leadId)
            .single();

          if (leadData && !leadError) {
            if (skipStateUpdate) {
              logger.info("mail.outlook.skip_state_update", { lead_id: leadId });
              await serviceClient
                .from("leads")
                .update({
                  last_activity_at: new Date().toISOString(),
                  last_outbound_at: new Date().toISOString(),
                })
                .eq("id", leadId);
            } else {
              // Manual send: call AI to analyze and update lead state
              try {
                const analysisResponse = await fetch(`${supabaseUrl}/functions/v1/ai_task`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Authorization": authHeader,
                  },
                  body: JSON.stringify({
                    task: "analyze_outgoing_email",
                    payload: {
                      lead_context: `Name: ${leadData.name}, Company: ${leadData.company}`,
                      current_stage: leadData.stage,
                      current_next_action: leadData.next_action_key || "none",
                      sent_email_subject: subject,
                      sent_email_body: htmlToPlainText(bodyHtml),
                    },
                  }),
                });

                if (analysisResponse.ok) {
                  const analysisData = await analysisResponse.json();
                  if (analysisData.ok && analysisData.content) {
                    try {
                      const analysis = JSON.parse(analysisData.content);
                      logger.info("mail.outlook.ai_analysis", { lead_id: leadId, analysis });

                      await serviceClient
                        .from("leads")
                        .update({
                          stage: analysis.suggested_stage || leadData.stage,
                          next_action_key: analysis.next_action_key,
                          next_action_label: analysis.next_action_label,
                          needs_action: analysis.needs_action ?? false,
                          last_outbound_at: new Date().toISOString(),
                          last_activity_at: new Date().toISOString(),
                          action_instructions: null,
                        })
                        .eq("id", leadId);
                    } catch (parseErr) {
                      logger.error("mail.outlook.ai_parse_failed", { error: String(parseErr) });
                    }
                  }
                }
              } catch (aiError) {
                logger.error("mail.outlook.ai_error", { error: String(aiError) });
                // Fallback: update basic timestamp fields
                await serviceClient
                  .from("leads")
                  .update({
                    last_activity_at: new Date().toISOString(),
                    last_outbound_at: new Date().toISOString(),
                  })
                  .eq("id", leadId);
              }
            }
          }
        }

        // Update draft status if draftId provided
        if (draftId) {
          await serviceClient
            .from("drafts")
            .update({ status: "sent" })
            .eq("id", draftId);
        }

        // Update deal memory with outbound info
        if (leadId) {
          try {
            const bodyPlain = htmlToPlainText(bodyHtml);
            const mem = await loadDealMemory(serviceClient, leadId, accountData.workspace_id);
            const updated = updateFromOutboundLite(mem, bodyPlain, subject);
            await saveDealMemory(serviceClient, updated);
          } catch (memErr) {
            logger.error("mail.outlook.deal_memory_update_failed", { error: String(memErr) });
          }
        }
      } catch (bgError) {
        logger.error("mail.outlook.background_error", { error: String(bgError) });
      }
    };

    const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil: (p: Promise<void>) => void } }).EdgeRuntime;
    if (runtime?.waitUntil) {
      runtime.waitUntil(backgroundTasks());
    } else {
      backgroundTasks().catch(e => logger.error("mail.outlook.bg_fire_forget", { error: String(e) }));
    }

    return new Response(
      JSON.stringify({ ok: true, messageId: null }), // Graph sendMail doesn't return message ID
      { headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const errorId = crypto.randomUUID();
    const errorMessage = err instanceof Error ? err.message : "An error occurred";
    logger.error("mail.outlook.send_error", { error_id: errorId, error: errorMessage });

    const needsReconnect =
      errorMessage.includes("expired") ||
      errorMessage.includes("reauthorize") ||
      errorMessage.includes("revoked");

    return new Response(
      JSON.stringify({ ok: false, error: errorMessage, error_id: errorId, needsReconnect }),
      { status: 200, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
    );
  }
});
