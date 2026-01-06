import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{ mimeType: string; body?: { data?: string } }>;
  };
  internalDate: string;
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return decodeURIComponent(escape(atob(base64)));
  } catch {
    return atob(base64);
  }
}

function getHeader(headers: Array<{ name: string; value: string }>, name: string): string | undefined {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function getMessageBody(message: GmailMessage): string {
  if (message.payload.body?.data) {
    return decodeBase64Url(message.payload.body.data);
  }
  
  if (message.payload.parts) {
    const textPart = message.payload.parts.find(p => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      return decodeBase64Url(textPart.body.data);
    }
    const htmlPart = message.payload.parts.find(p => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      const html = decodeBase64Url(htmlPart.body.data);
      return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    }
  }
  
  return message.snippet || "";
}

interface GmailConnection {
  user_id: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  gmail_email: string;
}

// deno-lint-ignore no-explicit-any
async function refreshTokenIfNeeded(supabase: any, connection: GmailConnection): Promise<string> {
  const expiresAt = new Date(connection.token_expires_at);
  const now = new Date();
  
  if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
    console.log(`[background-sync] Refreshing token for ${connection.gmail_email}`);
    
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
      throw new Error("Failed to refresh token");
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

async function syncLeadEmails(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  accessToken: string,
  leadId: string,
  leadEmail: string,
  maxResults = 10
): Promise<{ synced: number; errors: string[] }> {
  const errors: string[] = [];
  let synced = 0;

  try {
    const query = `from:${leadEmail} OR to:${leadEmail}`;
    const searchUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`;
    
    const searchResponse = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!searchResponse.ok) {
      errors.push(`Search failed for ${leadEmail}`);
      return { synced, errors };
    }

    const searchData = await searchResponse.json();
    const messageIds = searchData.messages || [];

    // Get existing Gmail message IDs for deduplication
    const { data: existingInteractions } = await supabase
      .from("interactions")
      .select("gmail_message_id")
      .eq("lead_id", leadId)
      .eq("source", "gmail")
      .not("gmail_message_id", "is", null);

    const existingMessageIds = new Set(
      (existingInteractions || []).map((i: { gmail_message_id: string }) => i.gmail_message_id)
    );

    for (const { id: gmailMessageId } of messageIds) {
      // Skip if already synced
      if (existingMessageIds.has(gmailMessageId)) {
        continue;
      }

      try {
        const msgResponse = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailMessageId}?format=full`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        if (!msgResponse.ok) continue;

        const message: GmailMessage = await msgResponse.json();
        const headers = message.payload.headers;
        
        const from = getHeader(headers, "From") || "";
        const to = getHeader(headers, "To") || "";
        const subject = getHeader(headers, "Subject") || "(no subject)";
        const date = getHeader(headers, "Date");
        const occurredAt = date ? new Date(date).toISOString() : new Date(parseInt(message.internalDate)).toISOString();

        const isFromLead = from.toLowerCase().includes(leadEmail.toLowerCase());
        const type = isFromLead ? "email_inbound" : "email_outbound";
        const bodyText = getMessageBody(message);

        const { error: insertError } = await supabase
          .from("interactions")
          .insert({
            lead_id: leadId,
            type,
            source: "gmail",
            occurred_at: occurredAt,
            subject,
            from_email: from,
            to_email: to,
            body_text: bodyText.substring(0, 10000),
            gmail_message_id: gmailMessageId,
          });

        if (insertError) {
          // Skip duplicate key errors silently
          if (!insertError.message.includes("duplicate")) {
            errors.push(`Insert failed: ${insertError.message}`);
          }
        } else {
          synced++;
          existingMessageIds.add(gmailMessageId);
        }
      } catch (err) {
        errors.push(`Message error: ${err instanceof Error ? err.message : "Unknown"}`);
      }
    }

    if (synced > 0) {
      await supabase
        .from("leads")
        .update({ last_activity_at: new Date().toISOString() })
        .eq("id", leadId);
    }
  } catch (err) {
    errors.push(`Lead sync error: ${err instanceof Error ? err.message : "Unknown"}`);
  }

  return { synced, errors };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  console.log("[background-sync] Starting background Gmail sync...");

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get all Gmail connections
    const { data: connections, error: connError } = await supabase
      .from("gmail_connections")
      .select("*");

    if (connError) {
      console.error("[background-sync] Failed to fetch connections:", connError);
      return new Response(
        JSON.stringify({ ok: false, error: "Failed to fetch connections" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!connections || connections.length === 0) {
      console.log("[background-sync] No Gmail connections found");
      return new Response(
        JSON.stringify({ ok: true, message: "No connections to sync", synced: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`[background-sync] Found ${connections.length} Gmail connection(s)`);

    let totalSynced = 0;
    const allErrors: string[] = [];
    const results: Array<{ user: string; leads: number; synced: number }> = [];

    for (const connection of connections as GmailConnection[]) {
      try {
        // Refresh token if needed
        const accessToken = await refreshTokenIfNeeded(supabase, connection);

        // Get all leads for this user
        const { data: leads, error: leadsError } = await supabase
          .from("leads")
          .select("id, email")
          .eq("owner_user_id", connection.user_id);

        if (leadsError || !leads || leads.length === 0) {
          console.log(`[background-sync] No leads for user ${connection.user_id}`);
          continue;
        }

        console.log(`[background-sync] Syncing ${leads.length} leads for ${connection.gmail_email}`);

        let userSynced = 0;
        for (const lead of leads) {
          const { synced, errors } = await syncLeadEmails(
            supabase,
            accessToken,
            lead.id,
            lead.email,
            5 // Limit per lead for background sync
          );
          userSynced += synced;
          allErrors.push(...errors);
        }

        totalSynced += userSynced;
        results.push({
          user: connection.gmail_email,
          leads: leads.length,
          synced: userSynced,
        });

        // Update last_sync_at for this connection
        await supabase
          .from("gmail_connections")
          .update({ last_sync_at: new Date().toISOString() })
          .eq("user_id", connection.user_id);

      } catch (err) {
        const errorMsg = `User ${connection.user_id} error: ${err instanceof Error ? err.message : "Unknown"}`;
        console.error(`[background-sync] ${errorMsg}`);
        allErrors.push(errorMsg);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`[background-sync] Completed in ${duration}ms. Total synced: ${totalSynced}`);

    return new Response(
      JSON.stringify({
        ok: true,
        totalSynced,
        connections: connections.length,
        results,
        errors: allErrors.length > 0 ? allErrors.slice(0, 10) : undefined,
        durationMs: duration,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorId = crypto.randomUUID();
    console.error(`[background-sync] Error ${errorId}:`, error);
    return new Response(
      JSON.stringify({ ok: false, error: "Background sync failed", error_id: errorId }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
