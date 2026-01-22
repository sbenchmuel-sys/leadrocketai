import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Dynamic CORS based on allowed origins
function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigins = Deno.env.get("ALLOWED_ORIGINS")?.split(",") || [];
  
  const isLocalhost = origin.includes("localhost") || origin.includes("127.0.0.1");
  const isLovableProject = origin.endsWith(".lovableproject.com");
  const isLovableApp = origin.endsWith(".lovable.app");
  const isAllowed = allowedOrigins.includes(origin) || isLocalhost || isLovableProject || isLovableApp || allowedOrigins.includes("*");
  
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

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

interface LeadMetrics {
  first_outbound_at: string | null;
  last_outbound_at: string | null;
  last_inbound_at: string | null;
  meeting_summary_count: number;
  nurture_outbound_count: number;
  last_nurture_outbound_at: string | null;
}

interface LeadUpdate {
  stage: string;
  needs_action: boolean;
  next_action_key: string | null;
  next_action_label: string | null;
  first_outbound_at: string | null;
  last_outbound_at: string | null;
  last_inbound_at: string | null;
  meeting_summary_count: number;
  nurture_outbound_count: number;
  last_nurture_outbound_at: string | null;
  last_activity_at: string;
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

// Convert HTML to readable plain text
function htmlToPlainText(html: string): string {
  let text = html;
  
  // Replace common block elements with newlines
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<\/tr>/gi, "\n");
  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<\/h[1-6]>/gi, "\n\n");
  
  // Remove script and style content
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  
  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");
  
  // Decode common HTML entities
  text = text.replace(/&nbsp;/gi, " ");
  text = text.replace(/&amp;/gi, "&");
  text = text.replace(/&lt;/gi, "<");
  text = text.replace(/&gt;/gi, ">");
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  text = text.replace(/&rsquo;/gi, "'");
  text = text.replace(/&lsquo;/gi, "'");
  text = text.replace(/&rdquo;/gi, '"');
  text = text.replace(/&ldquo;/gi, '"');
  text = text.replace(/&mdash;/gi, "—");
  text = text.replace(/&ndash;/gi, "–");
  text = text.replace(/&#\d+;/g, ""); // Remove other numeric entities
  
  // Normalize whitespace
  text = text.replace(/[ \t]+/g, " "); // Multiple spaces/tabs to single space
  text = text.replace(/\n[ \t]+/g, "\n"); // Remove leading whitespace on lines
  text = text.replace(/[ \t]+\n/g, "\n"); // Remove trailing whitespace on lines
  text = text.replace(/\n{3,}/g, "\n\n"); // Max 2 consecutive newlines
  
  return text.trim();
}

function getMessageBody(message: GmailMessage): string {
  // First try to get plain text
  if (message.payload.parts) {
    const textPart = message.payload.parts.find(p => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      return decodeBase64Url(textPart.body.data);
    }
  }
  
  // Fall back to direct body if it's plain text
  if (message.payload.body?.data) {
    const decoded = decodeBase64Url(message.payload.body.data);
    // Check if it's HTML
    if (decoded.includes("<html") || decoded.includes("<!DOCTYPE")) {
      return htmlToPlainText(decoded);
    }
    return decoded;
  }
  
  // Convert HTML to plain text
  if (message.payload.parts) {
    const htmlPart = message.payload.parts.find(p => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      const html = decodeBase64Url(htmlPart.body.data);
      return htmlToPlainText(html);
    }
  }
  
  return message.snippet || "";
}

// deno-lint-ignore no-explicit-any
async function refreshTokenIfNeeded(
  supabase: any,
  connection: { user_id: string; access_token: string; refresh_token: string; token_expires_at: string }
): Promise<string> {
  const expiresAt = new Date(connection.token_expires_at);
  const now = new Date();
  
  if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
    console.log("[gmail-sync] Refreshing expired token");
    
    const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
    const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
    
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      console.error("[gmail-sync] Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET");
      throw new Error("Missing Google OAuth credentials");
    }

    if (!connection.refresh_token) {
      console.error("[gmail-sync] No refresh token available - user needs to reconnect Gmail");
      throw new Error("No refresh token - please reconnect Gmail");
    }

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
      console.error("[gmail-sync] Token refresh failed:", response.status, errorBody);
      
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

// Check if email body contains closing-stage keywords
function containsClosingKeywords(text: string): boolean {
  const keywords = ["pricing", "contract", "procurement", "security review", "legal", "proposal", "quote", "budget"];
  const lowerText = text.toLowerCase();
  return keywords.some(kw => lowerText.includes(kw));
}

// Determine stage based on metrics
function deriveStage(
  currentStage: string,
  metrics: LeadMetrics,
  hasClosingKeywords: boolean
): string {
  // Manual overrides are preserved
  if (currentStage === "closed_won" || currentStage === "closed_lost") {
    return currentStage;
  }

  // Priority order (highest to lowest)
  // 1. Closing - suggested when inbound has closing keywords
  if (hasClosingKeywords && metrics.last_inbound_at) {
    return "closing";
  }

  // 2. Post-Meeting - has meeting summaries
  if (metrics.meeting_summary_count > 0) {
    return "post_meeting";
  }

  // 3. Engaged - has inbound after any outbound
  if (metrics.last_inbound_at && metrics.first_outbound_at) {
    const inboundTime = new Date(metrics.last_inbound_at).getTime();
    const firstOutTime = new Date(metrics.first_outbound_at).getTime();
    if (inboundTime > firstOutTime) {
      return "engaged";
    }
  }

  // 4. Contacted - has sent at least one outbound
  if (metrics.first_outbound_at) {
    return "contacted";
  }

  // 5. New - default
  return "new";
}

// Determine needs_action and next_action
function deriveAction(
  metrics: LeadMetrics,
  pendingDraftCount: number,
  nurtureCadence: string | null,
  stage: string,
  hasMeetingWithoutFollowup: boolean = false
): { needs_action: boolean; next_action_key: string | null; next_action_label: string | null } {
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  // A) Reply Pending - inbound exists and is newer than last outbound, elapsed > 6 hours
  if (metrics.last_inbound_at) {
    const inboundTime = new Date(metrics.last_inbound_at).getTime();
    const outboundTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
    
    if (inboundTime > outboundTime) {
      const elapsed = now - inboundTime;
      if (elapsed > 6 * HOUR) {
        return {
          needs_action: true,
          next_action_key: "reply_now",
          next_action_label: "Reply to customer",
        };
      }
    }
  }

  // B) Closing stage - follow up if no outbound in 3 days
  if (stage === "closing") {
    const lastOutTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
    if (now - lastOutTime > 3 * DAY) {
      return {
        needs_action: true,
        next_action_key: "closing_followup",
        next_action_label: "Follow up on proposal/contract",
      };
    }
  }

  // C) Pre-Meeting Follow-up Overdue (no inbound yet)
  if (metrics.first_outbound_at && !metrics.last_inbound_at && metrics.meeting_summary_count === 0) {
    const firstOutTime = new Date(metrics.first_outbound_at).getTime();
    const lastOutTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : firstOutTime;
    const daysSinceFirst = (now - firstOutTime) / DAY;
    const daysSinceLast = (now - lastOutTime) / DAY;

    // Count outbound emails to determine which follow-up is due
    // Rough heuristic: use time elapsed since first outbound
    if (daysSinceFirst >= 14 && daysSinceLast >= 7) {
      return {
        needs_action: true,
        next_action_key: "send_pre_4",
        next_action_label: "Send breakup email",
      };
    } else if (daysSinceFirst >= 7 && daysSinceLast >= 4) {
      return {
        needs_action: true,
        next_action_key: "send_pre_3",
        next_action_label: "Send follow-up Email 3",
      };
    } else if (daysSinceFirst >= 4 && daysSinceLast >= 3) {
      return {
        needs_action: true,
        next_action_key: "send_pre_2",
        next_action_label: "Send follow-up Email 2",
      };
    }
  }

  // D) Post-Meeting Recap Missing - only trigger if there's a meeting pack without follow-up email
  if (hasMeetingWithoutFollowup) {
    return {
      needs_action: true,
      next_action_key: "generate_post_meeting_recap",
      next_action_label: "Send post-meeting recap",
    };
  }

  // E) Nurture Cadence Due
  if (metrics.nurture_outbound_count > 0 && nurtureCadence) {
    const lastNurtureTime = metrics.last_nurture_outbound_at 
      ? new Date(metrics.last_nurture_outbound_at).getTime() 
      : 0;
    
    let intervalDays = 7; // default weekly
    if (nurtureCadence === "biweekly") intervalDays = 14;
    else if (nurtureCadence === "monthly") intervalDays = 30;

    if (now - lastNurtureTime >= intervalDays * DAY) {
      return {
        needs_action: true,
        next_action_key: `send_nurture_${metrics.nurture_outbound_count + 1}`,
        next_action_label: "Send nurture email",
      };
    }
  }

  // No action needed
  return { needs_action: false, next_action_key: null, next_action_label: null };
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

    const { leadId, leadEmail, maxResults = 20 } = await req.json();
    
    if (!leadId || !leadEmail) {
      return new Response(JSON.stringify({ ok: false, error: "Missing leadId or leadEmail" }), {
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

    // Get current lead data for strategy/cadence info
    const { data: leadData } = await supabase
      .from("leads")
      .select("stage, strategy")
      .eq("id", leadId)
      .single();

    const currentStage = leadData?.stage || "new";
    const strategy = leadData?.strategy || "fast";

    const serviceSupabase = createClient(supabaseUrl, supabaseServiceKey);
    const accessToken = await refreshTokenIfNeeded(serviceSupabase, connection);

    // Get existing thread IDs locked to this lead
    const { data: existingThreads } = await serviceSupabase
      .from("interactions")
      .select("gmail_thread_id")
      .eq("lead_id", leadId)
      .not("gmail_thread_id", "is", null);

    const lockedThreadIds = new Set<string>(
      (existingThreads || []).map(i => i.gmail_thread_id).filter(Boolean)
    );

    // Search for emails from/to this lead
    const query = `from:${leadEmail} OR to:${leadEmail}`;
    const searchUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`;
    
    const searchResponse = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();
      console.error("[gmail-sync] Search failed:", errorText);
      return new Response(JSON.stringify({ ok: false, error: "Gmail search failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const searchData = await searchResponse.json();
    const messageIds = searchData.messages || [];
    
    console.log(`[gmail-sync] Found ${messageIds.length} messages for ${leadEmail}`);

    // Get existing Gmail message IDs for deduplication
    const { data: existingInteractions } = await supabase
      .from("interactions")
      .select("gmail_message_id")
      .eq("lead_id", leadId)
      .not("gmail_message_id", "is", null);

    const existingMessageIds = new Set(
      (existingInteractions || []).map(i => i.gmail_message_id)
    );

    let synced = 0;
    const errors: string[] = [];
    let hasClosingKeywords = false;

    // Fetch and process each message
    for (const { id: gmailMessageId } of messageIds) {
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
        const threadId = message.threadId;
        
        // Lock this thread to this lead
        lockedThreadIds.add(threadId);
        
        const from = getHeader(headers, "From") || "";
        const to = getHeader(headers, "To") || "";
        const subject = getHeader(headers, "Subject") || "(no subject)";
        const date = getHeader(headers, "Date");
        const occurredAt = date ? new Date(date).toISOString() : new Date(parseInt(message.internalDate)).toISOString();

        // Determine direction based on whether from contains lead email
        const isFromLead = from.toLowerCase().includes(leadEmail.toLowerCase());
        const direction = isFromLead ? "inbound" : "outbound";
        const type = isFromLead ? "email_inbound" : "email_outbound";
        
        const bodyText = getMessageBody(message);

        // Check for closing keywords in inbound emails
        if (direction === "inbound" && containsClosingKeywords(bodyText + " " + subject)) {
          hasClosingKeywords = true;
        }

        const { error: insertError } = await serviceSupabase
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
            gmail_thread_id: threadId,
            direction,
          });

        if (insertError) {
          if (!insertError.message.includes("duplicate")) {
            errors.push(`Failed to insert message ${gmailMessageId}: ${insertError.message}`);
          }
        } else {
          synced++;
          existingMessageIds.add(gmailMessageId);
        }
      } catch (err) {
        errors.push(`Error processing message ${gmailMessageId}: ${err instanceof Error ? err.message : "Unknown"}`);
      }
    }

    // Also fetch messages from locked threads (thread lock rule)
    for (const threadId of lockedThreadIds) {
      try {
        const threadUrl = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`;
        const threadResponse = await fetch(threadUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!threadResponse.ok) continue;

        const threadData = await threadResponse.json();
        const threadMessages = threadData.messages || [];

        for (const message of threadMessages) {
          const gmailMessageId = message.id;
          if (existingMessageIds.has(gmailMessageId)) continue;

          const headers = message.payload?.headers || [];
          const from = getHeader(headers, "From") || "";
          const to = getHeader(headers, "To") || "";
          const subject = getHeader(headers, "Subject") || "(no subject)";
          const date = getHeader(headers, "Date");
          const occurredAt = date ? new Date(date).toISOString() : new Date(parseInt(message.internalDate)).toISOString();

          const isFromLead = from.toLowerCase().includes(leadEmail.toLowerCase());
          const direction = isFromLead ? "inbound" : "outbound";
          const type = isFromLead ? "email_inbound" : "email_outbound";
          
          const bodyText = getMessageBody(message);

          if (direction === "inbound" && containsClosingKeywords(bodyText + " " + subject)) {
            hasClosingKeywords = true;
          }

          const { error: insertError } = await serviceSupabase
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
              gmail_thread_id: threadId,
              direction,
            });

          if (!insertError) {
            synced++;
            existingMessageIds.add(gmailMessageId);
          }
        }
      } catch (err) {
        console.error(`[gmail-sync] Error fetching thread ${threadId}:`, err);
      }
    }

    // Now compute derived metrics from all interactions for this lead
    const { data: allInteractions } = await serviceSupabase
      .from("interactions")
      .select("type, direction, occurred_at, body_text")
      .eq("lead_id", leadId)
      .order("occurred_at", { ascending: true });

    // Meeting count is derived from meeting_packs (source of truth)
    const { data: meetingPacks } = await serviceSupabase
      .from("meeting_packs")
      .select("id, follow_up_email_body")
      .eq("lead_id", leadId);

    const meetingCount = meetingPacks?.length || 0;
    // Check if any meeting pack is missing a follow-up email
    const hasMeetingWithoutFollowup = (meetingPacks || []).some(
      (mp) => !mp.follow_up_email_body || mp.follow_up_email_body.trim() === ""
    );

    const metrics: LeadMetrics = {
      first_outbound_at: null,
      last_outbound_at: null,
      last_inbound_at: null,
      meeting_summary_count: meetingCount,
      nurture_outbound_count: 0,
      last_nurture_outbound_at: null,
    };

    for (const interaction of allInteractions || []) {
      const dir = interaction.direction || (interaction.type?.includes("inbound") ? "inbound" : "outbound");
      const occurredAt = interaction.occurred_at;
      const bodyLower = (interaction.body_text || "").toLowerCase();

      if (dir === "outbound") {
        if (!metrics.first_outbound_at) {
          metrics.first_outbound_at = occurredAt;
        }
        metrics.last_outbound_at = occurredAt;

        // Check if this is a nurture email (heuristic: contains nurture-related content)
        if (bodyLower.includes("nurture") || interaction.type === "nurture_email") {
          metrics.nurture_outbound_count++;
          metrics.last_nurture_outbound_at = occurredAt;
        }
      } else if (dir === "inbound") {
        metrics.last_inbound_at = occurredAt;

        // Check for closing keywords in historical inbound
        if (containsClosingKeywords(interaction.body_text || "")) {
          hasClosingKeywords = true;
        }
      }
    }

    // Get pending draft count for action logic
    const { data: pendingDrafts } = await serviceSupabase
      .from("drafts")
      .select("id, nurture_cadence")
      .eq("lead_id", leadId)
      .in("status", ["pending", "saved"]);

    const pendingDraftCount = pendingDrafts?.length || 0;
    const nurtureCadence = pendingDrafts?.find(d => d.nurture_cadence)?.nurture_cadence || 
                           (strategy === "nurture" ? "weekly" : null);

    // Derive stage and action
    const stage = deriveStage(currentStage, metrics, hasClosingKeywords);
    const { needs_action, next_action_key, next_action_label } = deriveAction(
      metrics, pendingDraftCount, nurtureCadence, stage, hasMeetingWithoutFollowup
    );

    // Update lead with computed values
    const leadUpdate: LeadUpdate = {
      stage,
      needs_action,
      next_action_key,
      next_action_label,
      first_outbound_at: metrics.first_outbound_at,
      last_outbound_at: metrics.last_outbound_at,
      last_inbound_at: metrics.last_inbound_at,
      meeting_summary_count: metrics.meeting_summary_count,
      nurture_outbound_count: metrics.nurture_outbound_count,
      last_nurture_outbound_at: metrics.last_nurture_outbound_at,
      last_activity_at: new Date().toISOString(),
    };

    await serviceSupabase
      .from("leads")
      .update(leadUpdate)
      .eq("id", leadId);

    // Update last_sync_at
    await serviceSupabase
      .from("gmail_connections")
      .update({ last_sync_at: new Date().toISOString() })
      .eq("user_id", user.id);

    // Process Zoom meeting summary emails with DEDICATED SEARCH (not just lead-specific emails)
    try {
      // Search specifically for Zoom summary emails across entire inbox
      const zoomQuery = 'from:zoom.us (subject:"Meeting assets" OR subject:"Meeting Summary")';
      const zoomSearchUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(zoomQuery)}&maxResults=50`;
      
      const zoomSearchResponse = await fetch(zoomSearchUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (zoomSearchResponse.ok) {
        const zoomSearchData = await zoomSearchResponse.json();
        const zoomMessageIds = zoomSearchData.messages || [];
        
        console.log(`[gmail-sync] Found ${zoomMessageIds.length} Zoom summary emails via dedicated search`);

        const zoomMessages = [];
        for (const { id: gmailMessageId } of zoomMessageIds) {
          const msgResponse = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmailMessageId}?format=full`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (!msgResponse.ok) continue;
          
          const message = await msgResponse.json();
          const headers = message.payload?.headers || [];
          const from = getHeader(headers, "From") || "";
          const subject = getHeader(headers, "Subject") || "";
          const date = getHeader(headers, "Date");
          const to = getHeader(headers, "To") || "";
          const cc = getHeader(headers, "Cc") || "";
          
          zoomMessages.push({
            user_id: user.id,
            gmail_message_id: gmailMessageId,
            gmail_thread_id: message.threadId,
            sent_at: date ? new Date(date).toISOString() : new Date(parseInt(message.internalDate)).toISOString(),
            subject,
            from_email: from,
            to_email: to,
            cc_email: cc,
            raw_text: getMessageBody(message),
          });
        }

        if (zoomMessages.length > 0) {
          console.log(`[gmail-sync] Processing ${zoomMessages.length} Zoom summary emails...`);
          await serviceSupabase.functions.invoke("process-zoom-summary", {
            body: { messages: zoomMessages, user_id: user.id },
          });
        }
      } else {
        console.error("[gmail-sync] Zoom search failed:", await zoomSearchResponse.text());
      }
    } catch (zoomErr) {
      console.error("[gmail-sync] Zoom processing error (non-blocking):", zoomErr);
    }

    console.log(`[gmail-sync] Synced ${synced} messages, stage=${stage}, needs_action=${needs_action}`);

    return new Response(
      JSON.stringify({ 
        ok: true, 
        synced, 
        total: messageIds.length,
        stage,
        needs_action,
        next_action_key,
        errors: errors.length > 0 ? errors : undefined 
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorId = crypto.randomUUID();
    console.error(`[gmail-sync] Error ${errorId}:`, error);
    return new Response(
      JSON.stringify({ ok: false, error: "An error occurred while syncing emails", error_id: errorId }),
      { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );
  }
});
