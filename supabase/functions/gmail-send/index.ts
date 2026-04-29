import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { safeDecryptToken, encryptToken } from "../_shared/encryption.ts";
import { isInternalCaller, assertLeadAccess } from "../_shared/authz.ts";
import { projectTimelineItem, emailDedupeKey } from "../_shared/timelineProjector.ts";
import { loadDealMemory, updateFromOutboundLite, saveDealMemory } from "../_shared/dealMemory.ts";
import { plainTextToHtml } from "../_shared/emailUtils.ts";

// Dynamic CORS based on allowed origins
function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigins = Deno.env.get("ALLOWED_ORIGINS")?.split(",") || [];
  
  // In development, allow localhost origins; in production, allow Lovable project domains
  const isLocalhost = origin.includes("localhost") || origin.includes("127.0.0.1");
  const isLovableProject = origin.endsWith(".lovableproject.com");
  const isLovableApp = origin.endsWith(".lovable.app");
  const isCustomDomain = origin === "https://drivepilot.app" || origin === "https://www.drivepilot.app";
  const isAllowed = allowedOrigins.includes(origin) || isLocalhost || isLovableProject || isLovableApp || isCustomDomain || allowedOrigins.includes("*");
  
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

function encodeBase64Url(str: string): string {
  const base64 = btoa(unescape(encodeURIComponent(str)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}


// deno-lint-ignore no-explicit-any
async function refreshTokenIfNeeded(
  supabase: any,
  connection: { user_id: string; access_token_encrypted: string | null; refresh_token_encrypted: string | null; token_expires_at: string }
): Promise<string> {
  const expiresAt = new Date(connection.token_expires_at);
  const now = new Date();
  
  // Decrypt the stored tokens (use encrypted columns)
  const rawAccessToken = connection.access_token_encrypted ?? "";
  const rawRefreshToken = connection.refresh_token_encrypted ?? "";
  const decryptedAccessToken = await safeDecryptToken(rawAccessToken);
  const decryptedRefreshToken = await safeDecryptToken(rawRefreshToken);
  
  if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
    console.log("[gmail-send] Refreshing expired token");
    
    const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
    
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: decryptedRefreshToken,
        grant_type: "refresh_token",
      }),
    });
    
    if (!response.ok) {
      const errorBody = await response.text();
      console.error("[gmail-send] Token refresh failed:", response.status, errorBody);
      
      // Check for revoked access
      if (errorBody.includes("invalid_grant")) {
        throw new Error("Gmail access revoked - please reconnect Gmail in Settings");
      }
      throw new Error(`Failed to refresh token: ${response.status}`);
    }
    
    const tokens = await response.json();
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    
    // Encrypt the new access token before storage
    let encryptedNewAccessToken = tokens.access_token;
    try {
      const hasEncryptionKey = !!Deno.env.get("TOKEN_ENCRYPTION_KEY");
      if (hasEncryptionKey) {
        encryptedNewAccessToken = await encryptToken(tokens.access_token);
      }
    } catch (encryptError) {
      console.error("[gmail-send] Token encryption failed, storing in plaintext:", encryptError);
    }
    
    await supabase
      .from("gmail_connections")
      .update({
        access_token_encrypted: encryptedNewAccessToken,
        token_expires_at: newExpiresAt,
      })
      .eq("user_id", connection.user_id);
    
    return tokens.access_token;
  }
  
  return decryptedAccessToken;
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, error: "Missing authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    // Check if this is an internal call (from automation-executor via X-Internal-Secret header)
    const isInternal = isInternalCaller(req);
    
    let userId: string;
    
    if (isInternal) {
      // For internal calls, parse body first to get ownerUserId
      const bodyText = await req.text();
      const bodyJson = JSON.parse(bodyText);
      if (!bodyJson.ownerUserId) {
        return new Response(JSON.stringify({ ok: false, error: "Internal calls require ownerUserId" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      userId = bodyJson.ownerUserId;
      // Store parsed body for later use
      (req as any)._parsedBody = bodyJson;
    } else {
      const supabase = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) {
        return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      userId = user.id;
    }

    const { to, cc, subject, body, leadId, draftId, threadId, replyToMessageId, skipStateUpdate } = (req as any)._parsedBody || await req.json();

    // Normalize recipients: accept either legacy `to: string` or new `to: string[]`,
    // plus optional `cc: string[]`. The first To address remains the canonical
    // primary recipient for legacy code paths that read `to_email`.
    const toArr: string[] = Array.isArray(to)
      ? to.map((s) => String(s).trim()).filter(Boolean)
      : (typeof to === "string" && to.trim() ? [to.trim()] : []);
    const ccArr: string[] = Array.isArray(cc)
      ? cc.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const primaryTo = toArr[0] ?? "";

    if (toArr.length === 0 || !subject || !body) {
      return new Response(JSON.stringify({ ok: false, error: "Missing to, subject, or body" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify lead access using canonical workspace-safe helper
    if (leadId && !isInternal) {
      const serviceCheckClient = createClient(supabaseUrl, supabaseServiceKey);
      const authzCheck = await assertLeadAccess(serviceCheckClient, leadId, userId);
      if (!authzCheck.ok) {
        console.error(`[gmail-send] Lead access denied: leadId=${leadId}, userId=${userId}, reason=${authzCheck.error}`);
        return new Response(JSON.stringify({ ok: false, error: authzCheck.error || "Lead access denied" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Create service role client first - needed to access encrypted tokens
    const serviceSupabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get Gmail connection using service role (column-level security blocks token access for regular users)
    const { data: connection, error: connError } = await serviceSupabase
      .from("gmail_connections")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (connError || !connection) {
      return new Response(JSON.stringify({ ok: false, error: "Gmail not connected" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accessToken = await refreshTokenIfNeeded(serviceSupabase, connection);

    // Build RFC 2822 email with threading headers if replying.
    // To/Cc are comma-separated per RFC 2822; Gmail API accepts the raw header.
    const emailLines = [
      `To: ${toArr.join(", ")}`,
    ];
    if (ccArr.length > 0) {
      emailLines.push(`Cc: ${ccArr.join(", ")}`);
    }
    emailLines.push(
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset=utf-8`,
    );

    // Add In-Reply-To and References headers for threading
    if (replyToMessageId) {
      emailLines.push(`In-Reply-To: <${replyToMessageId}>`);
      emailLines.push(`References: <${replyToMessageId}>`);
      console.log(`[gmail-send] Adding threading headers for reply to message: ${replyToMessageId}`);
    }

    emailLines.push(``, body);
    const rawEmail = emailLines.join("\r\n");
    const encodedEmail = encodeBase64Url(rawEmail);

    // Send via Gmail API (include threadId if replying to keep in same thread)
    const sendPayload: { raw: string; threadId?: string } = { raw: encodedEmail };
    if (threadId) {
      sendPayload.threadId = threadId;
      console.log(`[gmail-send] Sending as part of thread: ${threadId}`);
    }
    
    const sendResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sendPayload),
    });

    if (!sendResponse.ok) {
      const errorText = await sendResponse.text();
      console.error("[gmail-send] Send failed:", sendResponse.status, errorText);
      
      // Check if it's an auth/token issue
      const needsReconnect = errorText.includes("invalid_grant") || 
                             errorText.includes("Invalid Credentials") ||
                             errorText.includes("Token has been expired or revoked") ||
                             errorText.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") ||
                             errorText.includes("insufficientPermissions") ||
                             errorText.includes("insufficient authentication scopes") ||
                             sendResponse.status === 401 ||
                             sendResponse.status === 403;
      
      // Parse Gmail error for a better message
      let gmailErrorMessage = "Failed to send email";
      try {
        const parsed = JSON.parse(errorText);
        if (parsed?.error?.message) {
          gmailErrorMessage = parsed.error.message;
        }
      } catch { /* use default */ }

      // For 404 (thread/message not found), strip threading and retry as a fresh email.
      // IMPORTANT: On success, fall through to the normal backgroundTasks path so that
      // the interaction + timeline records are created (not returned early).
      if (sendResponse.status === 404 && threadId) {
        console.log("[gmail-send] Thread not found (404), retrying as fresh email without threadId");
        const retryPayload = { raw: encodedEmail }; // no threadId
        const retryResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(retryPayload),
        });
        if (retryResponse.ok) {
          const retryData = await retryResponse.json();
          console.log(`[gmail-send] 404 retry succeeded, message ID: ${retryData.id}`);
          // Reassign sendResponse/sendData so the normal success path handles bookkeeping
          // We create a synthetic "ok" response and break out of the error block
          // by jumping to the success path below (sendData will be set after this block)
          (req as any)._retryData = retryData;
        } else {
          const retryError = await retryResponse.text();
          console.error("[gmail-send] Retry also failed:", retryResponse.status, retryError);
        }
      }

      // If 404 retry succeeded, skip the error return and use retry data
      if ((req as any)._retryData) {
        // Fall through — sendData will be assigned below
      } else {
        return new Response(JSON.stringify({ 
          ok: false, 
          error: needsReconnect
            ? "Gmail permissions need updating - please reauthorize Gmail in Settings"
            : gmailErrorMessage,
          needsReconnect,
        }), {
          // Always return 200 so the JSON error body is readable by the frontend
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Use retry data if 404 retry succeeded, otherwise parse normal response
    const sendData = (req as any)._retryData || await sendResponse.json();
    console.log(`[gmail-send] Email sent successfully, message ID: ${sendData.id}`);

    // Run post-send tasks in background so user gets immediate response
    const backgroundTasks = async () => {
      try {
        // Create interaction record if leadId provided
        if (leadId) {
          const interactionOccurredAt = new Date().toISOString();
          const { data: interactionRow } = await serviceSupabase
            .from("interactions")
            .insert({
              lead_id: leadId,
              type: "email_outbound",
              source: "gmail",
              occurred_at: interactionOccurredAt,
              subject,
              from_email: connection.gmail_email,
              to_email: primaryTo,
              to_emails: toArr,
              cc_emails: ccArr,
              body_text: body,
              gmail_message_id: sendData.id,
              gmail_thread_id: sendData.threadId || threadId || null,
            })
            .select("id")
            .single();

          // Project to unified timeline
          const { data: leadWs } = await serviceSupabase
            .from("leads").select("workspace_id").eq("id", leadId).single();
          if (leadWs?.workspace_id && interactionRow) {
            projectTimelineItem(serviceSupabase, {
              workspace_id: leadWs.workspace_id,
              lead_id: leadId,
              channel: "email",
              provider: "gmail",
              direction: "outbound",
              event_type: "email_outbound",
              occurred_at: interactionOccurredAt,
              source_table: "interactions",
              source_id: interactionRow.id,
              snippet_text: body?.substring(0, 500),
              subject,
              metadata_json: { gmail_message_id: sendData.id, from_email: connection.gmail_email, to_email: primaryTo, to_emails: toArr, cc_emails: ccArr },
              dedupe_key: emailDedupeKey("gmail", sendData.id, interactionRow.id),
            }).catch(e => console.warn("[gmail-send] Timeline projection failed:", e));
          }

          // Get current lead data for AI analysis
          const { data: leadData, error: leadError } = await serviceSupabase
            .from("leads")
            .select("stage, next_action_key, next_action_label, company, name")
            .eq("id", leadId)
            .single();

          if (leadData && !leadError) {
            // If this send was triggered by automation-executor, skip the AI state update.
            // The executor already handles post-send state correctly; overwriting here would
            // reset the next scheduled nurture step or action key back to a stale AI suggestion.
            if (skipStateUpdate) {
              console.log(`[gmail-send] skipStateUpdate=true — skipping AI analysis for automated send on lead ${leadId}`);
              // Only update timestamp fields — never touch action scheduling fields
              await serviceSupabase
                .from("leads")
                .update({
                  last_activity_at: new Date().toISOString(),
                  last_outbound_at: new Date().toISOString(),
                })
                .eq("id", leadId);
            } else {
              // Manual send: call AI to analyze and update lead state
              try {
                const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
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
                      sent_email_body: body,
                    },
                  }),
                });

                if (analysisResponse.ok) {
                  const analysisData = await analysisResponse.json();
                  if (analysisData.ok && analysisData.content) {
                    try {
                      const analysis = JSON.parse(analysisData.content);
                      console.log("[gmail-send] AI analysis result:", analysis);
                      
                      // Update lead with AI suggestions
                      await serviceSupabase
                        .from("leads")
                        .update({
                          stage: analysis.suggested_stage || leadData.stage,
                          next_action_key: analysis.next_action_key,
                          next_action_label: analysis.next_action_label,
                          needs_action: analysis.needs_action ?? false,
                          last_outbound_at: new Date().toISOString(),
                          last_activity_at: new Date().toISOString(),
                      // Keep action_instructions for automated campaign sequences; clear only for manual sends
                      ...(skipStateUpdate ? {} : { action_instructions: null }),
                        })
                        .eq("id", leadId);
                      
                      console.log(`[gmail-send] Lead ${leadId} updated with AI analysis`);
                    } catch (parseErr) {
                      console.error("[gmail-send] Failed to parse AI analysis:", parseErr);
                    }
                  }
                } else {
                  console.error("[gmail-send] AI analysis request failed:", await analysisResponse.text());
                }
              } catch (aiError) {
                console.error("[gmail-send] AI analysis error:", aiError);
                // Don't fail the send if AI analysis fails, just update basic fields
                await serviceSupabase
                  .from("leads")
                  .update({ 
                    last_activity_at: new Date().toISOString(),
                    last_outbound_at: new Date().toISOString(),
                  })
                  .eq("id", leadId);
              }
            }
          } else {
            // Update lead's last_activity_at if we couldn't get lead data
            await serviceSupabase
              .from("leads")
              .update({ last_activity_at: new Date().toISOString() })
              .eq("id", leadId);
          }
        }

        // Update draft status if draftId provided
        if (draftId) {
          await serviceSupabase
            .from("drafts")
            .update({ status: "sent" })
            .eq("id", draftId);
        }

        // Update deal memory with outbound info
        if (leadId) {
          try {
            const { data: leadWsData } = await serviceSupabase
              .from("leads").select("workspace_id").eq("id", leadId).single();
            if (leadWsData?.workspace_id) {
              const mem = await loadDealMemory(serviceSupabase, leadId, leadWsData.workspace_id);
              const updated = updateFromOutboundLite(mem, body, subject);
              await saveDealMemory(serviceSupabase, updated);
            }
          } catch (memErr) {
            console.error("[gmail-send] Deal memory update failed:", memErr);
          }
        }
      } catch (bgError) {
        console.error("[gmail-send] Background task error:", bgError);
      }
    };

    // Start background tasks without awaiting - user gets immediate response
    // Use EdgeRuntime.waitUntil if available, otherwise run inline
    const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil: (p: Promise<void>) => void } }).EdgeRuntime;
    if (runtime?.waitUntil) {
      runtime.waitUntil(backgroundTasks());
    } else {
      // Fallback: fire and forget
      backgroundTasks().catch(e => console.error("[gmail-send] Background error:", e));
    }

    return new Response(
      JSON.stringify({ ok: true, messageId: sendData.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorId = crypto.randomUUID();
    const errorMessage = error instanceof Error ? error.message : "An error occurred while sending the email";
    console.error(`[gmail-send] Error ${errorId}:`, error);
    
    // Check if this is a reconnection error
    const needsReconnect = errorMessage.includes("revoked") || 
                           errorMessage.includes("reconnect") ||
                           errorMessage.includes("invalid_grant");
    
    return new Response(
      JSON.stringify({ 
        ok: false, 
        error: errorMessage, 
        error_id: errorId,
        needsReconnect,
      }),
      { 
        // Always return 200 so the JSON body is readable by the frontend
        status: 200, 
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } 
      }
    );
  }
});
