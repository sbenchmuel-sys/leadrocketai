import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Dynamic CORS based on allowed origins
function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigins = Deno.env.get("ALLOWED_ORIGINS")?.split(",") || [];
  
  // In development, allow localhost origins; in production, allow Lovable project domains
  const isLocalhost = origin.includes("localhost") || origin.includes("127.0.0.1");
  const isLovableProject = origin.endsWith(".lovableproject.com");
  const isLovableApp = origin.endsWith(".lovable.app");
  const isAllowed = allowedOrigins.includes(origin) || isLocalhost || isLovableProject || isLovableApp || allowedOrigins.includes("*");
  
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
  connection: { user_id: string; access_token: string; refresh_token: string; token_expires_at: string }
): Promise<string> {
  const expiresAt = new Date(connection.token_expires_at);
  const now = new Date();
  
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
        refresh_token: connection.refresh_token,
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
    
    await supabase
      .from("gmail_connections")
      .update({
        access_token: tokens.access_token,
        token_expires_at: newExpiresAt,
      })
      .eq("user_id", connection.user_id);
    
    return tokens.access_token;
  }
  
  return connection.access_token;
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

    const { to, subject, body, leadId, draftId, threadId, replyToMessageId } = await req.json();
    
    if (!to || !subject || !body) {
      return new Response(JSON.stringify({ ok: false, error: "Missing to, subject, or body" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get Gmail connection
    const { data: connection, error: connError } = await supabase
      .from("gmail_connections")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (connError || !connection) {
      return new Response(JSON.stringify({ ok: false, error: "Gmail not connected" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceSupabase = createClient(supabaseUrl, supabaseServiceKey);
    const accessToken = await refreshTokenIfNeeded(serviceSupabase, connection);

    // Build RFC 2822 email with threading headers if replying
    const emailLines = [
      `To: ${to}`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset=utf-8`,
    ];
    
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
                             sendResponse.status === 401;
      
      return new Response(JSON.stringify({ 
        ok: false, 
        error: needsReconnect ? "Gmail access revoked - please reconnect Gmail in Settings" : "Failed to send email",
        needsReconnect,
      }), {
        // Return 200 for reconnect errors so supabase.functions.invoke doesn't throw
        status: needsReconnect ? 200 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sendData = await sendResponse.json();
    console.log(`[gmail-send] Email sent successfully, message ID: ${sendData.id}`);

    // Run post-send tasks in background so user gets immediate response
    const backgroundTasks = async () => {
      try {
        // Create interaction record if leadId provided
        if (leadId) {
          await serviceSupabase
            .from("interactions")
            .insert({
              lead_id: leadId,
              type: "email_outbound",
              source: "gmail",
              occurred_at: new Date().toISOString(),
              subject,
              from_email: connection.gmail_email,
              to_email: to,
              body_text: body,
              gmail_message_id: sendData.id,
              gmail_thread_id: sendData.threadId || threadId || null,
            });

          // Get current lead data for AI analysis
          const { data: leadData, error: leadError } = await serviceSupabase
            .from("leads")
            .select("stage, next_action_key, next_action_label, company, name")
            .eq("id", leadId)
            .single();

          if (leadData && !leadError) {
            // Call AI to analyze the outgoing email and update lead
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
                        action_instructions: null, // Clear instructions after send
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
        // Return 200 for reconnect errors so supabase.functions.invoke doesn't throw
        status: needsReconnect ? 200 : 500, 
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } 
      }
    );
  }
});
