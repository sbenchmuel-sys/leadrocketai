import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// ============================================
// CADENCE SETTINGS TYPES (mirrored from frontend)
// ============================================

interface TimeRules {
  timezone_mode: "workspace" | "lead";
  use_business_days: boolean;
  send_window_local: { start: string; end: string };
  avoid_weekends: boolean;
}

interface Guardrails {
  min_gap_hours_between_emails: number;
  max_emails_per_lead_per_7d: number;
  max_emails_per_lead_per_30d: number;
  same_day_send_allowed: boolean;
  jitter_percent: number;
}

interface StopPauseRules {
  stop_on_any_reply: boolean;
  stop_on_negative_reply: boolean;
  stop_on_unsubscribe: boolean;
  stop_on_bounce: boolean;
  pause_when_meeting_scheduled: boolean;
}

interface ModeSettings {
  reply_pending_hours: number;
  outbound_followups_days: number[];
  breakup_trigger: {
    days_since_first_outbound: number;
    days_since_last_outbound: number;
  };
  post_meeting: {
    recap_suggest_after_hours: number;
    checkins_days: number[];
  };
}

interface NurtureCampaignsFlow {
  enabled: boolean;
  cadences_days: { weekly: number; biweekly: number; monthly: number };
  min_days_after_last_touch: number;
}

interface ReengagementFlow {
  enabled: boolean;
  after_days_no_contact: number;
  sequence_days: number[];
}

interface PreMeetingFlow {
  enabled: boolean;
  reminder_hours_before: number[];
}

interface Flows {
  nurture_campaigns: NurtureCampaignsFlow;
  reengagement: ReengagementFlow;
  pre_meeting: PreMeetingFlow;
}

interface CadenceSettingsV1 {
  version: 1;
  time_rules: TimeRules;
  guardrails: Guardrails;
  stop_pause_rules: StopPauseRules;
  modes: {
    fast: ModeSettings;
    nurture: ModeSettings;
  };
  flows: Flows;
}

const DEFAULT_CADENCE_SETTINGS: CadenceSettingsV1 = {
  version: 1,
  time_rules: {
    timezone_mode: "workspace",
    use_business_days: true,
    send_window_local: { start: "09:00", end: "17:00" },
    avoid_weekends: true,
  },
  guardrails: {
    min_gap_hours_between_emails: 16,
    max_emails_per_lead_per_7d: 3,
    max_emails_per_lead_per_30d: 8,
    same_day_send_allowed: false,
    jitter_percent: 0.15,
  },
  stop_pause_rules: {
    stop_on_any_reply: true,
    stop_on_negative_reply: true,
    stop_on_unsubscribe: true,
    stop_on_bounce: true,
    pause_when_meeting_scheduled: true,
  },
  modes: {
    fast: {
      reply_pending_hours: 4,
      outbound_followups_days: [2, 3, 3, 4],
      breakup_trigger: { days_since_first_outbound: 10, days_since_last_outbound: 5 },
      post_meeting: { recap_suggest_after_hours: 4, checkins_days: [3, 7] },
    },
    nurture: {
      reply_pending_hours: 24,
      outbound_followups_days: [5, 7, 7, 10],
      breakup_trigger: { days_since_first_outbound: 30, days_since_last_outbound: 14 },
      post_meeting: { recap_suggest_after_hours: 24, checkins_days: [7, 14, 30] },
    },
  },
  flows: {
    nurture_campaigns: {
      enabled: true,
      cadences_days: { weekly: 7, biweekly: 14, monthly: 30 },
      min_days_after_last_touch: 7,
    },
    reengagement: {
      enabled: true,
      after_days_no_contact: 45,
      sequence_days: [0, 7],
    },
    pre_meeting: {
      enabled: false,
      reminder_hours_before: [24, 2],
    },
  },
};

// Deep merge for backwards compatibility (arrays are full override)
function deepMergeCadence<T extends object>(defaults: T, partial?: Partial<T>): T {
  if (!partial) return defaults;
  const result = { ...defaults };
  for (const key of Object.keys(partial) as (keyof T)[]) {
    const pv = partial[key];
    const dv = defaults[key];
    if (pv === undefined) continue;
    if (Array.isArray(pv)) {
      result[key] = pv as T[keyof T];
    } else if (typeof dv === 'object' && dv !== null && !Array.isArray(dv) && typeof pv === 'object' && pv !== null) {
      result[key] = deepMergeCadence(dv as object, pv as object) as T[keyof T];
    } else {
      result[key] = pv as T[keyof T];
    }
  }
  return result;
}

// Action reason codes for automation-ready infrastructure
type ActionReasonCode =
  | "REPLY_PENDING"
  | "FOLLOWUP_DUE"
  | "BREAKUP_DUE"
  | "NURTURE_DUE"
  | "REENGAGE_DUE"
  | "POST_MEETING_RECAP_DUE"
  | "POST_MEETING_CHECKIN_DUE"
  | "POST_MEETING_FOLLOWUP_DUE"
  | "CLOSING_FOLLOWUP_DUE"
  | "NURTURE_SWITCH_RECOMMENDED"
  | "NURTURE_CAMPAIGN_START";

// Deterministic jitter based on lead_id + action_key (no flicker between syncs)
function getDeterministicJitter(leadId: string, actionKey: string, jitterPercent: number): number {
  const hashStr = `${leadId}:${actionKey}`;
  let hash = 0;
  for (let i = 0; i < hashStr.length; i++) {
    const char = hashStr.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const normalized = (hash % 10000) / 10000;
  return (normalized * 2 - 1) * jitterPercent;
}

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

interface ActionResult {
  needs_action: boolean;
  next_action_key: string | null;
  next_action_label: string | null;
  eligible_at: string | null;
  action_reason_code: ActionReasonCode | null;
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

  const from = (getHeader(headers, "From") || "").toLowerCase();
  const to = (getHeader(headers, "To") || "").toLowerCase();
  const cc = (getHeader(headers, "Cc") || "").toLowerCase();
  const bcc = (getHeader(headers, "Bcc") || "").toLowerCase();
  const all = `${from} ${to} ${cc} ${bcc}`;

  return all.includes(needle);
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

// Determine needs_action and next_action using configurable cadence settings
function deriveAction(
  leadId: string,
  metrics: LeadMetrics,
  nurtureCadence: string | null,
  stage: string,
  hasMeetingWithoutFollowup: boolean,
  hasFutureMeeting: boolean,
  recentOutbound7d: number,
  recentOutbound30d: number,
  modeSettings: ModeSettings,
  guardrails: Guardrails,
  stopPauseRules: StopPauseRules,
  flows: Flows,
  timezone: string | null,
  strategy: string
): ActionResult & { auto_nurture_eligible?: boolean } {
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  // ============================================
  // STOP/PAUSE RULES (highest priority)
  // Precedence: bounce/unsub/negative → stop; inbound newer than last outbound → only reply_pending; meeting scheduled → pause
  // ============================================

  // Pause when meeting is scheduled (check actual future meeting, not stage)
  if (stopPauseRules.pause_when_meeting_scheduled && hasFutureMeeting) {
    console.log(`[gmail-sync] Lead ${leadId}: Pausing outbound - future meeting scheduled`);
    return {
      needs_action: false,
      next_action_key: "paused_meeting_scheduled",
      next_action_label: "Paused - meeting scheduled",
      eligible_at: null,
      action_reason_code: null,
    };
  }

  // ============================================
  // GUARDRAILS CHECK
  // ============================================

  // Check max emails limits
  if (recentOutbound7d >= guardrails.max_emails_per_lead_per_7d) {
    console.log(`[gmail-sync] Lead ${leadId}: Guardrail hit - max 7d emails (${recentOutbound7d}/${guardrails.max_emails_per_lead_per_7d})`);
    return {
      needs_action: false,
      next_action_key: null,
      next_action_label: null,
      eligible_at: null,
      action_reason_code: null,
    };
  }

  if (recentOutbound30d >= guardrails.max_emails_per_lead_per_30d) {
    console.log(`[gmail-sync] Lead ${leadId}: Guardrail hit - max 30d emails (${recentOutbound30d}/${guardrails.max_emails_per_lead_per_30d})`);
    return {
      needs_action: false,
      next_action_key: null,
      next_action_label: null,
      eligible_at: null,
      action_reason_code: null,
    };
  }

  // Check min gap between emails
  const lastOutTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
  const hoursSinceLastOut = (now - lastOutTime) / HOUR;
  
  if (hoursSinceLastOut < guardrails.min_gap_hours_between_emails && lastOutTime > 0) {
    // Not eligible yet - calculate when we will be
    const eligibleTime = lastOutTime + (guardrails.min_gap_hours_between_emails * HOUR);
    console.log(`[gmail-sync] Lead ${leadId}: Guardrail hit - min gap (${hoursSinceLastOut.toFixed(1)}h < ${guardrails.min_gap_hours_between_emails}h)`);
    return {
      needs_action: false,
      next_action_key: null,
      next_action_label: null,
      eligible_at: new Date(eligibleTime).toISOString(),
      action_reason_code: null,
    };
  }

  // Check same-day rule
  if (!guardrails.same_day_send_allowed && lastOutTime > 0) {
    const lastOutDate = new Date(lastOutTime).toDateString();
    const todayDate = new Date(now).toDateString();
    if (lastOutDate === todayDate) {
      console.log(`[gmail-sync] Lead ${leadId}: Guardrail hit - same day send not allowed`);
      return {
        needs_action: false,
        next_action_key: null,
        next_action_label: null,
        eligible_at: null,
        action_reason_code: null,
      };
    }
  }

  // ============================================
  // A) REPLY PENDING - inbound exists and is newer than last outbound
  // This is always allowed (stop_on_any_reply only affects follow-ups, not replies)
  // ============================================
  if (metrics.last_inbound_at) {
    const inboundTime = new Date(metrics.last_inbound_at).getTime();
    const outboundTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
    
    if (inboundTime > outboundTime) {
      const elapsed = now - inboundTime;
      const thresholdMs = modeSettings.reply_pending_hours * HOUR;
      
      if (elapsed > thresholdMs) {
        // Apply deterministic jitter for eligible_at
        const jitter = getDeterministicJitter(leadId, "reply_now", guardrails.jitter_percent);
        const eligibleAt = new Date(inboundTime + thresholdMs * (1 + jitter));
        
        return {
          needs_action: true,
          next_action_key: "reply_now",
          next_action_label: "Reply to customer",
          eligible_at: eligibleAt.toISOString(),
          action_reason_code: "REPLY_PENDING",
        };
      }
    }
  }

  // ============================================
  // CHECK STOP RULES (for non-reply actions)
  // If there's a recent inbound and stop_on_any_reply is true, don't suggest follow-ups
  // ============================================
  if (stopPauseRules.stop_on_any_reply && metrics.last_inbound_at) {
    const inboundTime = new Date(metrics.last_inbound_at).getTime();
    const outboundTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
    
    if (inboundTime > outboundTime) {
      // Lead replied - don't suggest follow-ups, only reply_pending (handled above if threshold met)
      return {
        needs_action: false,
        next_action_key: "wait_reply_threshold",
        next_action_label: "Waiting for reply threshold",
        eligible_at: null,
        action_reason_code: null,
      };
    }
  }

  // ============================================
  // B) CLOSING STAGE - follow up if no outbound in 3 days
  // ============================================
  if (stage === "closing") {
    if (now - lastOutTime > 3 * DAY) {
      const jitter = getDeterministicJitter(leadId, "closing_followup", guardrails.jitter_percent);
      const eligibleAt = new Date(lastOutTime + (3 * DAY) * (1 + jitter));
      
      return {
        needs_action: true,
        next_action_key: "closing_followup",
        next_action_label: "Follow up on proposal/contract",
        eligible_at: eligibleAt.toISOString(),
        action_reason_code: "CLOSING_FOLLOWUP_DUE",
      };
    }
  }

  // ============================================
  // C) PRE-MEETING FOLLOW-UP (no inbound yet, no meetings)
  // ============================================
  if (metrics.first_outbound_at && !metrics.last_inbound_at && metrics.meeting_summary_count === 0) {
    const firstOutTime = new Date(metrics.first_outbound_at).getTime();
    const daysSinceFirst = (now - firstOutTime) / DAY;
    const daysSinceLast = (now - lastOutTime) / DAY;

    const breakupTrigger = modeSettings.breakup_trigger;
    const followupDays = modeSettings.outbound_followups_days;

    // NURTURE SWITCH CHECK - Before breakup, check if we should suggest nurture switch
    // If in fast mode, 3+ follow-ups sent (estimate based on time), and no reply
    if (strategy === "fast" && daysSinceFirst >= breakupTrigger.days_since_first_outbound * 0.8) {
      // Estimate follow-up count based on cumulative days
      let estimatedFollowups = 0;
      let cumDays = 0;
      for (const days of followupDays) {
        cumDays += days;
        if (daysSinceFirst >= cumDays) {
          estimatedFollowups++;
        }
      }
      
      if (estimatedFollowups >= 3) {
        console.log(`[gmail-sync] Lead ${leadId}: Suggesting nurture switch (${estimatedFollowups} follow-ups, no reply)`);
        return {
          needs_action: true,
          next_action_key: "switch_to_nurture",
          next_action_label: "Consider switching to nurture mode",
          eligible_at: new Date(now).toISOString(),
          action_reason_code: "NURTURE_SWITCH_RECOMMENDED",
          auto_nurture_eligible: true,
        };
      }
    }

    // Breakup email check
    if (daysSinceFirst >= breakupTrigger.days_since_first_outbound && 
        daysSinceLast >= breakupTrigger.days_since_last_outbound) {
      const jitter = getDeterministicJitter(leadId, "send_pre_4", guardrails.jitter_percent);
      const eligibleAt = new Date(lastOutTime + (breakupTrigger.days_since_last_outbound * DAY) * (1 + jitter));
      
      return {
        needs_action: true,
        next_action_key: "send_pre_4",
        next_action_label: "Send breakup email",
        eligible_at: eligibleAt.toISOString(),
        action_reason_code: "BREAKUP_DUE",
      };
    }

    // Calculate cumulative days for each follow-up
    let cumulativeDays = 0;
    for (let i = 0; i < followupDays.length; i++) {
      cumulativeDays += followupDays[i];
      const nextStepIndex = i + 2; // fu1 is after intro, so step 2, 3, 4...
      
      if (nextStepIndex > 4) break; // Max 4 follow-ups
      
      const prevCumulativeDays = cumulativeDays - followupDays[i];
      
      if (daysSinceFirst >= cumulativeDays && daysSinceLast >= followupDays[i]) {
        const jitter = getDeterministicJitter(leadId, `send_pre_${nextStepIndex}`, guardrails.jitter_percent);
        const eligibleAt = new Date(lastOutTime + (followupDays[i] * DAY) * (1 + jitter));
        
        return {
          needs_action: true,
          next_action_key: `send_pre_${nextStepIndex}`,
          next_action_label: nextStepIndex === 4 ? "Send breakup email" : `Send follow-up Email ${nextStepIndex}`,
          eligible_at: eligibleAt.toISOString(),
          action_reason_code: "FOLLOWUP_DUE",
        };
      }
    }
  }

  // ============================================
  // D) POST-MEETING RECAP MISSING
  // ============================================
  if (hasMeetingWithoutFollowup) {
    const recapHours = modeSettings.post_meeting.recap_suggest_after_hours;
    // For post-meeting, we'd need meeting time - for now use last activity
    const jitter = getDeterministicJitter(leadId, "generate_post_meeting_recap", guardrails.jitter_percent);
    const eligibleAt = new Date(now); // Immediately eligible if meeting happened
    
    return {
      needs_action: true,
      next_action_key: "generate_post_meeting_recap",
      next_action_label: "Send post-meeting recap",
      eligible_at: eligibleAt.toISOString(),
      action_reason_code: "POST_MEETING_RECAP_DUE",
    };
  }

  // ============================================
  // D2) POST-MEETING FOLLOW-UP (no response in 7 days)
  // ============================================
  // If lead is in post_meeting stage, we sent a follow-up, but no response in 7 days
  if (stage === "post_meeting" && !hasMeetingWithoutFollowup) {
    const lastOutboundTime = metrics.last_outbound_at 
      ? new Date(metrics.last_outbound_at).getTime() 
      : 0;
    const lastInboundTime = metrics.last_inbound_at 
      ? new Date(metrics.last_inbound_at).getTime() 
      : 0;
    
    // Only trigger if we sent something and they haven't replied since
    if (lastOutboundTime > 0 && lastOutboundTime > lastInboundTime) {
      const daysSinceOutbound = (now - lastOutboundTime) / DAY;
      const POST_MEETING_FOLLOWUP_DAYS = 7;
      
      if (daysSinceOutbound >= POST_MEETING_FOLLOWUP_DAYS) {
        const jitter = getDeterministicJitter(leadId, "post_meeting_followup", guardrails.jitter_percent);
        const eligibleAt = new Date(lastOutboundTime + (POST_MEETING_FOLLOWUP_DAYS * DAY) * (1 + jitter));
        
        return {
          needs_action: true,
          next_action_key: "post_meeting_followup",
          next_action_label: "Follow up (no response in 7 days)",
          eligible_at: eligibleAt.toISOString(),
          action_reason_code: "POST_MEETING_FOLLOWUP_DUE",
        };
      }
    }
  }

  // ============================================
  // E) NURTURE CADENCE DUE
  // ============================================
  if (flows.nurture_campaigns.enabled && metrics.nurture_outbound_count > 0 && nurtureCadence) {
    const lastNurtureTime = metrics.last_nurture_outbound_at 
      ? new Date(metrics.last_nurture_outbound_at).getTime() 
      : 0;
    
    const cadenceDays = flows.nurture_campaigns.cadences_days;
    let intervalDays = cadenceDays.weekly; // default weekly
    if (nurtureCadence === "biweekly") intervalDays = cadenceDays.biweekly;
    else if (nurtureCadence === "monthly") intervalDays = cadenceDays.monthly;

    const daysSinceNurture = (now - lastNurtureTime) / DAY;
    
    if (daysSinceNurture >= intervalDays) {
      const jitter = getDeterministicJitter(leadId, `send_nurture_${metrics.nurture_outbound_count + 1}`, guardrails.jitter_percent);
      const eligibleAt = new Date(lastNurtureTime + (intervalDays * DAY) * (1 + jitter));
      
      return {
        needs_action: true,
        next_action_key: `send_nurture_${metrics.nurture_outbound_count + 1}`,
        next_action_label: "Send nurture email",
        eligible_at: eligibleAt.toISOString(),
        action_reason_code: "NURTURE_DUE",
      };
    }
  }

  // ============================================
  // F) RE-ENGAGEMENT (cold lead)
  // ============================================
  if (flows.reengagement.enabled) {
    const lastActivityTime = Math.max(
      metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0,
      metrics.last_inbound_at ? new Date(metrics.last_inbound_at).getTime() : 0
    );
    
    if (lastActivityTime > 0) {
      const daysSinceActivity = (now - lastActivityTime) / DAY;
      
      if (daysSinceActivity >= flows.reengagement.after_days_no_contact) {
        const jitter = getDeterministicJitter(leadId, "reengage", guardrails.jitter_percent);
        const eligibleAt = new Date(lastActivityTime + (flows.reengagement.after_days_no_contact * DAY) * (1 + jitter));
        
        return {
          needs_action: true,
          next_action_key: "reengage",
          next_action_label: "Re-engage cold lead",
          eligible_at: eligibleAt.toISOString(),
          action_reason_code: "REENGAGE_DUE",
        };
      }
    }
  }

  // No action needed
  return { 
    needs_action: false, 
    next_action_key: null, 
    next_action_label: null,
    eligible_at: null,
    action_reason_code: null,
  };
}

// LeadUpdate interface for database updates
interface LeadUpdate {
  stage: string;
  needs_action: boolean;
  next_action_key: string | null;
  next_action_label: string | null;
  eligible_at: string | null;
  action_reason_code: string | null;
  first_outbound_at: string | null;
  last_outbound_at: string | null;
  last_inbound_at: string | null;
  meeting_summary_count: number;
  nurture_outbound_count: number;
  last_nurture_outbound_at: string | null;
  last_activity_at: string;
  action_dismissed_at?: string | null; // Track manual dismissals
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

    // Get current lead data for strategy/cadence info AND owner_user_id for workspace settings
    const { data: leadData } = await supabase
      .from("leads")
      .select("stage, strategy, owner_user_id, has_future_meeting, action_dismissed_at")
      .eq("id", leadId)
      .single();

    const currentStage = leadData?.stage || "new";
    const strategy = leadData?.strategy || "fast";
    const ownerUserId = leadData?.owner_user_id || user.id;
    const hasFutureMeeting = leadData?.has_future_meeting || false;
    const actionDismissedAt = leadData?.action_dismissed_at || null;

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
    const query = `from:${leadEmailNorm} OR to:${leadEmailNorm}`;
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
        
        // Lock this thread to this lead
        lockedThreadIds.add(threadId);
        
        // Safety check: never attach a message to a lead unless the headers actually include the lead email
        if (!messageInvolvesLead(headers, leadEmailNorm)) {
          console.warn(
            `[gmail-sync] Skipping message ${gmailMessageId} (does not involve lead email ${leadEmailNorm})`
          );
          continue;
        }

        const from = getHeader(headers, "From") || "";
        const to = getHeader(headers, "To") || "";
        const subject = getHeader(headers, "Subject") || "(no subject)";
        const date = getHeader(headers, "Date");
        const occurredAt = date ? new Date(date).toISOString() : new Date(parseInt(message.internalDate)).toISOString();

        // Determine direction based on whether from contains lead email
        const isFromLead = from.toLowerCase().includes(leadEmailNorm.toLowerCase());
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
          if (!messageInvolvesLead(headers, leadEmailNorm)) {
            console.warn(
              `[gmail-sync] Skipping thread message ${gmailMessageId} in thread ${threadId} (does not involve lead email ${leadEmailNorm})`
            );
            continue;
          }

          const from = getHeader(headers, "From") || "";
          const to = getHeader(headers, "To") || "";
          const subject = getHeader(headers, "Subject") || "(no subject)";
          const date = getHeader(headers, "Date");
          const occurredAt = date ? new Date(date).toISOString() : new Date(parseInt(message.internalDate)).toISOString();

          const isFromLead = from.toLowerCase().includes(leadEmailNorm.toLowerCase());
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
      .select("id, follow_up_email_body, meeting_date, created_at")
      .eq("lead_id", leadId);

    const meetingCount = meetingPacks?.length || 0;
    
    // Check if any meeting pack is missing a follow-up email
    // BUT also check if an outbound email was sent after the meeting date OR after pack creation
    let hasMeetingWithoutFollowup = false;
    
    for (const mp of meetingPacks || []) {
      // If follow-up email already set, skip
      if (mp.follow_up_email_body && mp.follow_up_email_body.trim() !== "") {
        continue;
      }
      
      // Use meeting_date if available, otherwise fall back to pack creation time (created_at)
      // We need to check if ANY outbound was sent after this meeting/pack
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
          // An outbound email was sent after this meeting - mark as followed up
          console.log(`[gmail-sync] Auto-marking meeting pack ${mp.id} as followed up (email sent after meeting/pack creation)`);
          await serviceSupabase
            .from("meeting_packs")
            .update({ 
              follow_up_email_body: "[Sent via Gmail]",
              follow_up_email_subject: "Follow-up" 
            })
            .eq("id", mp.id);
          continue;
        }
      }
      
      // This meeting pack truly has no follow-up
      hasMeetingWithoutFollowup = true;
    }

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

    const nurtureCadence = pendingDrafts?.find(d => d.nurture_cadence)?.nurture_cadence || 
                           (strategy === "nurture" ? "weekly" : null);

    // Load cadence settings from workspace_profiles by owner_user_id
    const { data: workspaceProfile } = await serviceSupabase
      .from("workspace_profiles")
      .select("cadence_settings, meeting_timezone")
      .eq("user_id", ownerUserId)
      .maybeSingle();

    const cadenceSettings = deepMergeCadence(DEFAULT_CADENCE_SETTINGS, workspaceProfile?.cadence_settings || {});
    const timezone = workspaceProfile?.meeting_timezone || null;
    const modeSettings = cadenceSettings.modes[strategy as 'fast' | 'nurture'] || cadenceSettings.modes.fast;

    // Count recent outbound for guardrails
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const recentOutbound7d = (allInteractions || []).filter(i => 
      i.direction === 'outbound' && 
      new Date(i.occurred_at).getTime() > now - 7 * DAY
    ).length;
    const recentOutbound30d = (allInteractions || []).filter(i => 
      i.direction === 'outbound' && 
      new Date(i.occurred_at).getTime() > now - 30 * DAY
    ).length;

    // Derive stage and action
    const stage = deriveStage(currentStage, metrics, hasClosingKeywords);
    const actionResult = deriveAction(
      leadId,
      metrics,
      nurtureCadence,
      stage,
      hasMeetingWithoutFollowup,
      hasFutureMeeting,
      recentOutbound7d,
      recentOutbound30d,
      modeSettings,
      cadenceSettings.guardrails,
      cadenceSettings.stop_pause_rules,
      cadenceSettings.flows,
      timezone,
      strategy
    );

    // ============================================
    // DISMISSAL CHECK - Respect manual dismissals
    // ============================================
    const dismissedAt = actionDismissedAt ? new Date(actionDismissedAt).getTime() : 0;
    const lastInteractionTime = Math.max(
      metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0,
      metrics.last_inbound_at ? new Date(metrics.last_inbound_at).getTime() : 0
    );

    let finalAction = actionResult;
    let shouldClearDismissal = false;

    // If dismissed after last interaction, respect the dismissal
    if (dismissedAt > 0 && dismissedAt > lastInteractionTime) {
      console.log(`[gmail-sync] Lead ${leadId}: Respecting manual dismissal from ${actionDismissedAt}`);
      finalAction = {
        needs_action: false,
        next_action_key: null,
        next_action_label: null,
        eligible_at: null,
        action_reason_code: null,
        auto_nurture_eligible: actionResult.auto_nurture_eligible,
      };
    } else if (dismissedAt > 0 && lastInteractionTime > dismissedAt) {
      // New interaction occurred after dismissal, clear the dismissal flag
      console.log(`[gmail-sync] Lead ${leadId}: Clearing dismissal - new interaction detected`);
      shouldClearDismissal = true;
    }

    // Update lead with computed values
    const leadUpdate: LeadUpdate & { auto_nurture_eligible?: boolean } = {
      stage,
      needs_action: finalAction.needs_action,
      next_action_key: finalAction.next_action_key,
      next_action_label: finalAction.next_action_label,
      eligible_at: finalAction.eligible_at,
      action_reason_code: finalAction.action_reason_code,
      first_outbound_at: metrics.first_outbound_at,
      last_outbound_at: metrics.last_outbound_at,
      last_inbound_at: metrics.last_inbound_at,
      meeting_summary_count: metrics.meeting_summary_count,
      nurture_outbound_count: metrics.nurture_outbound_count,
      last_nurture_outbound_at: metrics.last_nurture_outbound_at,
      last_activity_at: new Date().toISOString(),
    };

    // Handle action_dismissed_at field
    if (shouldClearDismissal) {
      // New interaction occurred after dismissal - clear it
      leadUpdate.action_dismissed_at = null;
    } else if (dismissedAt > 0) {
      // Dismissal is still valid - explicitly preserve it (don't let undefined clear it)
      // Don't include in update to preserve existing value
    }

    // Set auto_nurture_eligible if the action suggests it
    if (finalAction.auto_nurture_eligible !== undefined) {
      leadUpdate.auto_nurture_eligible = finalAction.auto_nurture_eligible;
    }

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
