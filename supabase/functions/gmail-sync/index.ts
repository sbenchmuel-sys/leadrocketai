import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { safeDecryptToken, encryptToken } from "../_shared/encryption.ts";
import { isOutOfOfficeReply, getOOOEligibleAt, detectDeferSignal } from "../_shared/oooDetection.ts";
import { isHumanUnsubscribeRequest } from "../_shared/unsubscribeDetection.ts";
import {
  type CadenceSettingsV1,
  type LeadMetrics,
  type LeadUpdate,
  type ActionResult,
  DEFAULT_CADENCE_SETTINGS,
  deepMergeCadence,
  getDeterministicJitter,
  extractEmailAddresses,
  htmlToPlainText,
  containsClosingKeywords,
  getCorsHeaders,
  deriveStage,
  deriveAction,
  computeMetricsFromInteractions,
  buildLeadUpdate,
} from "../_shared/syncEngine.ts";

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
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

function messageInvolvesLead(headers: Array<{ name: string; value: string }>, leadEmail: string): boolean {
  const needle = leadEmail.trim().toLowerCase();
  if (!needle) return false;
  const from = getHeader(headers, "From") || "";
  const to = getHeader(headers, "To") || "";
  const cc = getHeader(headers, "Cc") || "";
  const bcc = getHeader(headers, "Bcc") || "";
  const allEmails = [
    ...extractEmailAddresses(from),
    ...extractEmailAddresses(to),
    ...extractEmailAddresses(cc),
    ...extractEmailAddresses(bcc),
  ];
  return allEmails.some(email => email === needle);
}

function getMessageBody(message: GmailMessage): string {
  if (message.payload.parts) {
    const textPart = message.payload.parts.find(p => p.mimeType === "text/plain");
    if (textPart?.body?.data) {
      return decodeBase64Url(textPart.body.data);
    }
  }
  if (message.payload.body?.data) {
    const decoded = decodeBase64Url(message.payload.body.data);
    if (decoded.includes("<html") || decoded.includes("<!DOCTYPE")) {
      return htmlToPlainText(decoded);
    }
    return decoded;
  }
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
  connection: { user_id: string; access_token_encrypted: string | null; refresh_token_encrypted: string | null; token_expires_at: string }
): Promise<string> {
  const expiresAt = new Date(connection.token_expires_at);
  const now = new Date();
  const decryptedAccessToken = await safeDecryptToken(connection.access_token_encrypted ?? "");
  const decryptedRefreshToken = await safeDecryptToken(connection.refresh_token_encrypted ?? "");
  if (expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
    console.log("[gmail-sync] Refreshing expired token");
    const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
    const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      console.error("[gmail-sync] Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET");
      throw new Error("Missing Google OAuth credentials");
    }
    if (!decryptedRefreshToken) {
      console.error("[gmail-sync] No refresh token available - user needs to reconnect Gmail");
      throw new Error("No refresh token - please reconnect Gmail");
    }
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
      console.error("[gmail-sync] Token refresh failed:", response.status, errorBody);
      if (errorBody.includes("invalid_grant")) {
        throw new Error("Gmail access revoked - please reconnect Gmail in Settings");
      }
      throw new Error(`Failed to refresh token: ${response.status}`);
    }
    const tokens = await response.json();
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    let encryptedNewAccessToken = tokens.access_token;
    try {
      const hasEncryptionKey = !!Deno.env.get("TOKEN_ENCRYPTION_KEY");
      if (hasEncryptionKey) {
        encryptedNewAccessToken = await encryptToken(tokens.access_token);
      }
    } catch (encryptError) {
      console.error("[gmail-sync] Token encryption failed, storing in plaintext:", encryptError);
    }
    await supabase
      .from("gmail_connections")
      .update({ access_token_encrypted: encryptedNewAccessToken, token_expires_at: newExpiresAt })
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
    const leadEmailNorm = typeof leadEmail === "string" ? leadEmail.trim() : "";
    
    if (!leadId || !leadEmailNorm) {
      return new Response(JSON.stringify({ ok: false, error: "Missing leadId or leadEmail" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create service role client first - needed to access encrypted tokens
    const serviceSupabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get Gmail connection using service role (column-level security blocks token access for regular users)
    const { data: connection, error: connError } = await serviceSupabase
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

    // Get current lead data for strategy/cadence info AND owner_user_id for workspace settings
    const { data: leadData } = await supabase
      .from("leads")
      .select("stage, strategy, owner_user_id, has_future_meeting, action_dismissed_at, created_at, motion, nurture_status, ooo_until")
      .eq("id", leadId)
      .single();

    const currentStage = leadData?.stage || "new";
    const strategy = leadData?.strategy || "fast";
    const ownerUserId = leadData?.owner_user_id || user.id;
    const hasFutureMeeting = leadData?.has_future_meeting || false;
    const actionDismissedAt = leadData?.action_dismissed_at || null;
    const leadMotion = leadData?.motion || "outbound_prospecting";

    const accessToken = await refreshTokenIfNeeded(serviceSupabase, connection);

    // Note: Thread-based expansion removed — it caused cross-lead contamination.
    // Gmail search `from:X OR to:X` + per-message `messageInvolvesLead` check is sufficient.

    // Search for emails from/to this lead, scoped to 30 days before lead creation
    // IMPORTANT: Quote the email address to force Gmail exact matching (not partial/fuzzy)
    const leadCreatedAt = leadData?.created_at ? new Date(leadData.created_at) : new Date();
    const syncStartDate = new Date(leadCreatedAt);
    syncStartDate.setDate(syncStartDate.getDate() - 30);
    const afterDateStr = `${syncStartDate.getFullYear()}/${String(syncStartDate.getMonth() + 1).padStart(2, '0')}/${String(syncStartDate.getDate()).padStart(2, '0')}`;
    const query = `(from:"${leadEmailNorm}" OR to:"${leadEmailNorm}") after:${afterDateStr}`;
    
    // Server-side date cutoff for additional safety (Gmail after: can be unreliable)
    const syncStartMs = syncStartDate.getTime();
    const searchUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`;
    
    const searchResponse = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();
      console.error("[gmail-sync] Search failed:", errorText);

      const scopeInsufficient =
        errorText.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") ||
        errorText.includes("insufficientPermissions") ||
        errorText.includes("insufficient authentication scopes") ||
        errorText.includes("PERMISSION_DENIED");

      return new Response(
        JSON.stringify({
          ok: false,
          error: scopeInsufficient
            ? "Gmail permissions need updating - please reauthorize Gmail in Settings"
            : "Gmail search failed",
          needsReconnect: scopeInsufficient,
        }),
        {
          // Keep 200 on reconnect-required errors so the frontend can handle it without throw.
          status: scopeInsufficient ? 200 : 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const searchData = await searchResponse.json();
    const messageIds = searchData.messages || [];
    
    console.log(`[gmail-sync] Found ${messageIds.length} messages for ${leadEmailNorm}`);

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
        
        // Skip draft messages — only sync sent and received emails
        if (message.labelIds?.includes("DRAFT")) {
          console.log(`[gmail-sync] Skipping draft message ${gmailMessageId}`);
          continue;
        }
        
        // Safety check: never attach a message to a lead unless the headers actually include the lead email
        if (!messageInvolvesLead(headers, leadEmailNorm)) {
          console.warn(
            `[gmail-sync] Skipping message ${gmailMessageId} (does not involve lead email ${leadEmailNorm})`
          );
          continue;
        }

        // Extract headers needed for direction filter and subsequent processing
        const from = getHeader(headers, "From") || "";
        const to = getHeader(headers, "To") || "";

        // STRICT DIRECTION FILTER: Only sync emails that are directly between the rep and the lead.
        // Skip 3rd-party emails (newsletters, notifications, etc.) that happen to be addressed to the lead.
        const repEmail = connection.gmail_email?.toLowerCase().trim() || "";
        const fromEmailsForFilter = extractEmailAddresses(from);
        const toEmailsForFilter = extractEmailAddresses(to);
        const isFromLead_check = fromEmailsForFilter.some(e => e === leadEmailNorm.toLowerCase());
        const isFromRep_check = repEmail && fromEmailsForFilter.some(e => e === repEmail);
        const isToLead_check = toEmailsForFilter.some(e => e === leadEmailNorm.toLowerCase());
        const isToRep_check = repEmail && toEmailsForFilter.some(e => e === repEmail);

        // Only allow: (lead → rep) or (rep → lead). Skip everything else.
        const isDirectConversation = (isFromLead_check && isToRep_check) || (isFromRep_check && isToLead_check);
        if (!isDirectConversation) {
          console.log(
            `[gmail-sync] Skipping 3rd-party message ${gmailMessageId} (not direct rep↔lead email, from: "${from}", to: "${to}")`
          );
          continue;
        }

        // Server-side date guard: skip messages older than sync start date
        const msgDate = getHeader(headers, "Date");
        const msgInternalDate = parseInt(message.internalDate);
        const msgTimestamp = msgDate ? new Date(msgDate).getTime() : msgInternalDate;
        if (msgTimestamp < syncStartMs) {
          console.warn(
            `[gmail-sync] Skipping message ${gmailMessageId} (too old: ${new Date(msgTimestamp).toISOString()} < ${syncStartDate.toISOString()})`
          );
          continue;
        }

        const subject = getHeader(headers, "Subject") || "(no subject)";
        const date = getHeader(headers, "Date");
        const occurredAt = date ? new Date(date).toISOString() : new Date(parseInt(message.internalDate)).toISOString();

        // Thread ID stored for reference only (no thread expansion)

        // Determine direction based on whether from contains lead email (exact match)
        const fromEmails = extractEmailAddresses(from);
        const isFromLead = fromEmails.some(e => e === leadEmailNorm.toLowerCase());
        const direction = isFromLead ? "inbound" : "outbound";
        const type = isFromLead ? "email_inbound" : "email_outbound";
        
        const bodyText = getMessageBody(message);

        // Check for closing keywords in inbound emails
        if (direction === "inbound" && containsClosingKeywords(bodyText + " " + subject)) {
          hasClosingKeywords = true;
        }

        // Bounce / undeliverable detection — check before unsubscribe
        // These are system-generated messages sent from postmaster/mailer-daemon
        const fromLower = from.toLowerCase();
        const subjectLower = subject.toLowerCase();
        const isBounce = (
          fromLower.includes("postmaster") ||
          fromLower.includes("mailer-daemon") ||
          fromLower.includes("mail delivery") ||
          subjectLower.includes("delivery status notification") ||
          subjectLower.includes("undeliverable") ||
          subjectLower.includes("mail delivery failed") ||
          subjectLower.includes("returned mail") ||
          subjectLower.includes("failure notice") ||
          subjectLower.includes("delivery failure")
        );

        if (isBounce) {
          console.log(`[gmail-sync] Lead ${leadId}: Bounce detected (subject: "${subject}", from: "${from}") — stopping automation`);
          await serviceSupabase.from("leads").update({
            unsubscribed: true,
            needs_action: false,
            eligible_at: null,
            next_action_key: null,
            next_action_label: null,
            action_reason_code: null,
            nurture_status: "inactive",
          }).eq("id", leadId);

          await serviceSupabase.from("interactions").insert({
            lead_id: leadId,
            type: "system_note",
            source: "automation",
            body_text: `Email bounced/undeliverable (subject: "${subject}") — automation stopped permanently. Please verify the email address.`,
            occurred_at: new Date().toISOString(),
          });
        }

        // OOO / Auto-reply detection — must run BEFORE last_inbound_at is updated
        // OOO replies should NOT count as real inbound activity
        if (direction === "inbound" && !isBounce) {
          const oooResult = isOutOfOfficeReply(headers, subject, bodyText);
          if (oooResult.isOOO) {
            const eligibleAt = getOOOEligibleAt(oooResult.returnDate);
            const returnDateStr = oooResult.returnDate
              ? oooResult.returnDate.toLocaleDateString("en-US", { month: "long", day: "numeric" })
              : "approximately 7 days";
            const leadName = leadEmailNorm; // we don't have name here, use email as fallback

            console.log(`[gmail-sync] Lead ${leadId}: OOO auto-reply detected (confidence: ${oooResult.confidence}). Return date: ${returnDateStr}. Pausing until ${eligibleAt}`);

            // Update lead: pause automation, set ooo_until, do NOT touch last_inbound_at
            await serviceSupabase.from("leads").update({
              ooo_until: oooResult.returnDate ? oooResult.returnDate.toISOString() : eligibleAt,
              eligible_at: eligibleAt,
              needs_action: false,
              next_action_key: null,
              next_action_label: null,
              action_reason_code: null,
            }).eq("id", leadId);

            // Log as system_note so it appears in timeline but doesn't affect metrics
            await serviceSupabase.from("interactions").insert({
              lead_id: leadId,
              type: "system_note",
              source: "automation",
              body_text: `📵 OOO auto-reply detected (${oooResult.confidence} signal). ${leadName} is out of office — returning ${returnDateStr}. Automation paused until then.`,
              occurred_at: occurredAt,
              gmail_message_id: gmailMessageId,
              gmail_thread_id: threadId,
            });

            // Skip normal interaction insert — this is not a real inbound
            existingMessageIds.add(gmailMessageId);
            synced++;
            continue;
          }
        }

        // Unsubscribe detection in inbound emails.
        // IMPORTANT: Only trigger if:
        //   1. The email is FROM the lead (direction === "inbound")
        //   2. There is NO List-Unsubscribe header (which indicates a newsletter/bulk email, not a human reply)
        //   3. The phrase matches a human opt-out, not a newsletter footer link
        const hasListUnsubscribeHeader = !!getHeader(headers, "List-Unsubscribe");
        if (direction === "inbound" && !hasListUnsubscribeHeader) {
          const bodyLower = bodyText.toLowerCase();
          if (isHumanUnsubscribeRequest(bodyLower)) {
            console.log(`[gmail-sync] Lead ${leadId}: Unsubscribe keyword detected in inbound email`);
            await serviceSupabase.from("leads").update({
              unsubscribed: true,
              needs_action: false,
              eligible_at: null,
              next_action_key: null,
              next_action_label: null,
              action_reason_code: null,
              nurture_status: "inactive",
            }).eq("id", leadId);

            await serviceSupabase.from("interactions").insert({
              lead_id: leadId,
              type: "system_note",
              source: "automation",
              body_text: "Lead requested to unsubscribe — automation stopped permanently.",
              occurred_at: new Date().toISOString(),
            });
          }
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




    // Now compute derived metrics from all interactions for this lead
    const { data: allInteractions } = await serviceSupabase
      .from("interactions")
      .select("type, direction, occurred_at, body_text")
      .eq("lead_id", leadId)
      .order("occurred_at", { ascending: true });

    const { data: meetingPacks } = await serviceSupabase
      .from("meeting_packs")
      .select("id, follow_up_email_body, meeting_date, created_at")
      .eq("lead_id", leadId);

    const meetingCount = meetingPacks?.length || 0;
    
    let hasMeetingWithoutFollowup = false;
    for (const mp of meetingPacks || []) {
      if (mp.follow_up_email_body && mp.follow_up_email_body.trim() !== "") continue;
      const referenceDate = mp.meeting_date || (mp as any).created_at;
      if (referenceDate) {
        const { data: postMeetingEmails } = await serviceSupabase
          .from("interactions")
          .select("id, body_text, occurred_at")
          .eq("lead_id", leadId)
          .eq("direction", "outbound")
          .gt("occurred_at", referenceDate)
          .order("occurred_at", { ascending: false })
          .limit(1);
        if (postMeetingEmails && postMeetingEmails.length > 0) {
          console.log(`[gmail-sync] Auto-marking meeting pack ${mp.id} as followed up`);
          await serviceSupabase
            .from("meeting_packs")
            .update({ follow_up_email_body: "[Sent via Gmail]", follow_up_email_subject: "Follow-up" })
            .eq("id", mp.id);
          continue;
        }
      }
      hasMeetingWithoutFollowup = true;
    }

    // Use shared metrics computation
    const metricsResult = computeMetricsFromInteractions(allInteractions || [], meetingCount);
    const metrics = metricsResult.metrics;
    if (metricsResult.hasClosingKeywords) hasClosingKeywords = true;

    const { data: pendingDrafts } = await serviceSupabase
      .from("drafts")
      .select("id, nurture_cadence")
      .eq("lead_id", leadId)
      .in("status", ["pending", "saved"]);

    const nurtureCadence = pendingDrafts?.find(d => d.nurture_cadence)?.nurture_cadence || 
                           (strategy === "nurture" ? "weekly" : null);

    const { data: workspaceProfile } = await serviceSupabase
      .from("workspace_profiles")
      .select("cadence_settings, meeting_timezone")
      .eq("user_id", ownerUserId)
      .maybeSingle();

    const cadenceSettings = deepMergeCadence(DEFAULT_CADENCE_SETTINGS, workspaceProfile?.cadence_settings || {});
    const timezone = workspaceProfile?.meeting_timezone || null;
    const modeSettings = cadenceSettings.modes[strategy as 'fast' | 'nurture'] || cadenceSettings.modes.fast;

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const recentOutbound7d = (allInteractions || []).filter(i => 
      i.direction === 'outbound' && new Date(i.occurred_at).getTime() > now - 7 * DAY
    ).length;
    const recentOutbound30d = (allInteractions || []).filter(i => 
      i.direction === 'outbound' && new Date(i.occurred_at).getTime() > now - 30 * DAY
    ).length;

    const stage = deriveStage(currentStage, metrics, hasClosingKeywords);
    const actionResult = deriveAction(
      leadId, metrics, nurtureCadence, stage, hasMeetingWithoutFollowup, hasFutureMeeting,
      recentOutbound7d, recentOutbound30d, modeSettings, cadenceSettings.guardrails,
      cadenceSettings.stop_pause_rules, cadenceSettings.flows, timezone, strategy, leadMotion
    );

    // Use shared lead update builder (handles dismissal, active automation, OOO)
    const { data: currentLeadState } = await serviceSupabase
      .from("leads")
      .select("eligible_at, needs_action, motion, nurture_status, ooo_until")
      .eq("id", leadId)
      .single();

    const leadUpdate = buildLeadUpdate(
      stage, metrics, actionResult, actionDismissedAt,
      currentLeadState ? {
        needs_action: currentLeadState.needs_action,
        eligible_at: currentLeadState.eligible_at,
        motion: currentLeadState.motion,
        nurture_status: currentLeadState.nurture_status,
        ooo_until: currentLeadState.ooo_until,
      } : null
    );

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

    console.log(`[gmail-sync] Synced ${synced} messages, stage=${stage}, needs_action=${actionResult.needs_action}`);

    return new Response(
      JSON.stringify({ 
        ok: true, 
        synced, 
        total: messageIds.length,
        stage,
        needs_action: actionResult.needs_action,
        next_action_key: actionResult.next_action_key,
        eligible_at: actionResult.eligible_at,
        action_reason_code: actionResult.action_reason_code,
        errors: errors.length > 0 ? errors : undefined 
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorId = crypto.randomUUID();
    const errorMessage = error instanceof Error ? error.message : "An error occurred while syncing emails";
    const needsReconnect =
      errorMessage.toLowerCase().includes("invalid_grant") ||
      errorMessage.toLowerCase().includes("revoked") ||
      errorMessage.toLowerCase().includes("reconnect") ||
      errorMessage.toLowerCase().includes("insufficient") ||
      errorMessage.toLowerCase().includes("permissions");

    console.error(`[gmail-sync] Error ${errorId}:`, error);
    return new Response(
      JSON.stringify({ ok: false, error: errorMessage, error_id: errorId, needsReconnect }),
      {
        // Keep 200 on reconnect-required errors so the frontend can handle it without throw.
        status: needsReconnect ? 200 : 500,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      }
    );
  }
});
