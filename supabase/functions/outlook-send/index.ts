// ============================================================
// POST /outlook-send
//
// Body: { mail_account_id, to, subject, bodyHtml, threadId? }
//
// Uses token auto-refresh middleware before every Graph API call.
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getFreshOutlookToken } from "../_shared/outlookTokens.ts";
import { logger } from "../_shared/logger.ts";

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

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await userClient.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { mail_account_id, to, subject, bodyHtml, threadId } = body;

    if (!mail_account_id || !to || !subject || !bodyHtml) {
      return new Response(
        JSON.stringify({ ok: false, error: "mail_account_id, to, subject, bodyHtml are required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    const serviceClient = createClient(supabaseUrl, supabaseServiceKey);

    // Auto-refresh token (throws + marks expired if refresh fails)
    const accessToken = await getFreshOutlookToken(mail_account_id, serviceClient);

    // Build Graph sendMail payload
    const mailPayload: Record<string, unknown> = {
      message: {
        subject,
        body: { contentType: "HTML", content: bodyHtml },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    };

    // If replying in thread, attach conversationId via internetMessageHeaders not available in sendMail
    // Instead use reply endpoint if threadId looks like a Graph messageId
    let sendUrl = "https://graph.microsoft.com/v1.0/me/sendMail";
    let sendPayload = mailPayload;

    if (threadId) {
      // threadId in Outlook context = Graph message ID to reply to
      sendUrl = `https://graph.microsoft.com/v1.0/me/messages/${threadId}/reply`;
      sendPayload = {
        message: {
          body: { contentType: "HTML", content: bodyHtml },
        },
        comment: "",
      };
    }

    const sendResp = await fetch(sendUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sendPayload),
    });

    if (!sendResp.ok) {
      const errText = await sendResp.text();
      logger.error("mail.outlook.send_failed", {
        mail_account_id,
        status: sendResp.status,
        error: errText,
      });
      return new Response(
        JSON.stringify({ ok: false, error: `Graph sendMail failed (${sendResp.status})`, detail: errText }),
        { status: 200, headers: { ...cors, "Content-Type": "application/json" } }
      );
    }

    // 202 Accepted from Graph = success (no body)
    logger.info("mail.outlook.email_sent", {
      mail_account_id,
      to,
      subject,
      has_thread: !!threadId,
    });

    // Update last_sync_at as a lightweight activity marker
    await serviceClient
      .from("mail_accounts")
      .update({ last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", mail_account_id);

    return new Response(
      JSON.stringify({ ok: true, messageId: null }), // Graph sendMail doesn't return message ID
      { headers: { ...cors, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const errorId = crypto.randomUUID();
    logger.error("mail.outlook.send_error", { error_id: errorId, error: String(err) });
    return new Response(
      JSON.stringify({ ok: false, error: "Internal error", error_id: errorId }),
      { status: 200, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } }
    );
  }
});
