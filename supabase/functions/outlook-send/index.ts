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
import { plainTextToHtml } from "../_shared/emailUtils.ts";

// Detect whether `body` already contains HTML markup. If not, treat it as
// plain text and convert via plainTextToHtml so Outlook (Graph contentType:HTML)
// renders paragraphs and line breaks instead of collapsing whitespace into
// one wall of text. Frontend `sendEmail` paths forward the composer's plain
// textarea contents as `bodyHtml`, so this normalization is required.
function ensureHtmlBody(body: string): string {
  if (!body) return body;
  // Heuristic: any well-formed tag means treat as HTML already.
  if (/<\/?(p|br|div|html|body|span|a|table|ul|ol|li|h[1-6]|strong|em|hr)\b/i.test(body)) {
    return body;
  }
  return plainTextToHtml(body);
}

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

// PR 2.4 follow-up — Microsoft Graph's /sendMail and /messages/{id}/reply
// both return 202 Accepted with NO body, so we can't capture the new
// message's id from the send call itself. We look it up post-202 via Sent
// Items, filtered by recipient + a tight time window.
//
// Failure is non-fatal — any HTTP error / empty result / no-recipient-match
// returns { null, null } and the caller proceeds with null ids (graceful
// degradation: the outbound row still gets written, just without the
// Graph message id, and the Follow-up button on it falls back to the
// existing "Couldn't thread reply — sending as new email" path).
async function lookupSentMessageId(
  accessToken: string,
  primaryTo: string,
  sendStartedAt: string,
): Promise<{ providerMessageId: string | null; conversationId: string | null }> {
  const sendStartedAtMs = new Date(sendStartedAt).getTime();
  const targetLower = (primaryTo || "").toLowerCase();
  // Filter floor: send-time minus 60s to absorb clock skew between our
  // edge function and Graph's sentDateTime. The defensive guard below
  // re-tightens to messages at-or-after the actual send.
  const filterFloor = new Date(sendStartedAtMs - 60_000).toISOString();
  const url =
    "https://graph.microsoft.com/v1.0/me/mailFolders/SentItems/messages" +
    "?$top=5" +
    "&$orderby=sentDateTime desc" +
    "&$select=id,internetMessageId,subject,toRecipients,sentDateTime,conversationId" +
    `&$filter=sentDateTime ge ${filterFloor}`;

  // Returns:
  //   - { id, conversationId } when a match is found
  //   - { null, null } when HTTP failed, throttled, or no recipient match in top-5
  //   - null to signal "value[] empty, retry once"
  const tryOnce = async (): Promise<
    { providerMessageId: string | null; conversationId: string | null } | null
  > => {
    try {
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });
      if (!resp.ok) {
        // 401/403/429/etc — non-fatal, no retry (would just compound throttling).
        logger.warn("mail.outlook.sent_items_lookup_http", { status: resp.status });
        return { providerMessageId: null, conversationId: null };
      }
      const data = await resp.json();
      const items: Array<{
        id: string;
        conversationId: string;
        toRecipients?: Array<{ emailAddress?: { address?: string } }>;
        sentDateTime: string;
      }> = Array.isArray(data?.value) ? data.value : [];
      if (items.length === 0) return null; // not yet materialized — signal retry

      // Recipient match FIRST, then defensive guard on sentDateTime.
      // Order matters: we never accept a stale matching message just because
      // it happens to match by recipient.
      for (const m of items) {
        const matched = (m.toRecipients ?? []).some(
          (r) => (r?.emailAddress?.address ?? "").toLowerCase() === targetLower,
        );
        if (!matched) continue;
        if (new Date(m.sentDateTime).getTime() < sendStartedAtMs) continue;
        return { providerMessageId: m.id, conversationId: m.conversationId ?? null };
      }
      // Top-5 returned but none matched recipient + guard. Don't retry — the
      // result set is unlikely to change shape on a second read.
      return { providerMessageId: null, conversationId: null };
    } catch (err) {
      logger.warn("mail.outlook.sent_items_lookup_failed", { error: String(err) });
      return { providerMessageId: null, conversationId: null };
    }
  };

  const first = await tryOnce();
  if (first !== null) return first;

  // value[] was empty — single retry after 1.5s for materialization lag.
  await new Promise((r) => setTimeout(r, 1500));
  const second = await tryOnce();
  return second ?? { providerMessageId: null, conversationId: null };
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
    const { mail_account_id, to, cc, subject, bodyHtml, threadId, leadId, draftId, skipStateUpdate, ownerUserId } = body;

    // Normalize recipients: accept either legacy `to: string` or new `to: string[]`,
    // plus optional `cc: string[]`. The first To address remains the canonical
    // primary recipient for legacy code paths that read `to_email`.
    const toArr: string[] = Array.isArray(to)
      ? to.map((s: unknown) => String(s).trim()).filter(Boolean)
      : (typeof to === "string" && to.trim() ? [to.trim()] : []);
    const ccArr: string[] = Array.isArray(cc)
      ? cc.map((s: unknown) => String(s).trim()).filter(Boolean)
      : [];
    const primaryTo = toArr[0] ?? "";

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

    if (!mail_account_id || toArr.length === 0 || !subject || !bodyHtml) {
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

    // Build Graph sendMail payload — multi-recipient via toRecipients[] + ccRecipients[]
    const toRecipientsPayload = toArr.map((addr) => ({ emailAddress: { address: addr } }));
    const ccRecipientsPayload = ccArr.map((addr) => ({ emailAddress: { address: addr } }));

    let sendUrl = "https://graph.microsoft.com/v1.0/me/sendMail";
    let sendPayload: Record<string, unknown> = {
      message: {
        subject,
        body: { contentType: "HTML", content: bodyHtml },
        toRecipients: toRecipientsPayload,
        ...(ccRecipientsPayload.length > 0 ? { ccRecipients: ccRecipientsPayload } : {}),
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
          toRecipients: toRecipientsPayload,
          ...(ccRecipientsPayload.length > 0 ? { ccRecipients: ccRecipientsPayload } : {}),
        },
        comment: "",
      };
    } else if (threadId) {
      logger.info("mail.outlook.thread_id_not_message_id_fallback", {
        mail_account_id,
        thread_id_len: threadId.length,
      });
    }

    // PR 2.4 follow-up — captured immediately before the Graph send call so
    // the post-202 Sent Items lookup can use it as the time-window floor and
    // as the defensive guard for "this message must be at-or-after our send".
    const sendStartedAt = new Date().toISOString();

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
          toRecipients: toRecipientsPayload,
          ...(ccRecipientsPayload.length > 0 ? { ccRecipients: ccRecipientsPayload } : {}),
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
      to: toArr,
      cc: ccArr,
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

          // PR 2.4 follow-up — capture the Graph message-id of the email we
          // just sent so per-row Follow-up can anchor on /messages/{id}/reply
          // for THIS specific outbound. Lookup runs in the background, after
          // the user-facing 202; failures fall through to null ids and the
          // outbound row still gets written normally.
          let providerMessageId: string | null = null;
          let conversationId: string | null = null;
          try {
            const captured = await lookupSentMessageId(accessToken, primaryTo, sendStartedAt);
            providerMessageId = captured.providerMessageId;
            conversationId = captured.conversationId;
            if (providerMessageId) {
              logger.info("mail.outlook.sent_items_capture", {
                mail_account_id,
                lead_id: leadId,
                has_conversation_id: !!conversationId,
              });
            } else {
              logger.warn("mail.outlook.sent_items_capture_missed", {
                mail_account_id,
                lead_id: leadId,
              });
            }
          } catch (lookupErr) {
            // Defensive — lookupSentMessageId already wraps its own failures
            // and never throws, but keep this guard so a future regression
            // can never abort the row insert.
            logger.warn("mail.outlook.sent_items_lookup_unexpected", { error: String(lookupErr) });
          }

          // Create interaction record. The legacy `gmail_message_id` /
          // `gmail_thread_id` columns are the same slots outlook-sync uses
          // for the Graph message id and conversationId — mirror that
          // pattern (see outlook-sync/index.ts:419-420).
          const { data: interactionRow } = await serviceClient
            .from("interactions")
            .insert({
              lead_id: leadId,
              type: "email_outbound",
              source: "outlook",
              occurred_at: interactionOccurredAt,
              subject,
              from_email: accountEmail,
              to_email: primaryTo,
              to_emails: toArr,
              cc_emails: ccArr,
              body_text: bodyPlainText.substring(0, 10000),
              direction: "outbound",
              gmail_message_id: providerMessageId,
              gmail_thread_id: conversationId,
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
              metadata_json: {
                from_email: accountEmail,
                to_email: primaryTo,
                to_emails: toArr,
                cc_emails: ccArr,
                provider_message_id: providerMessageId,
                conversation_id: conversationId,
              },
              // PR 2.4 follow-up — when providerMessageId is non-null this
              // produces "outlook:<gid>" which collides with outlook-sync's
              // future re-fetch of the same Sent Items message, enabling
              // idempotent dedupe. When null, falls back to the UUID branch
              // (today's behaviour, unchanged).
              dedupe_key: emailDedupeKey("outlook", providerMessageId, interactionRow.id),
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
