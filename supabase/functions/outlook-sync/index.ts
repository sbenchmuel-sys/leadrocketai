// ============================================================
// outlook-sync — Mirror of gmail-sync for Outlook/Graph API
//
// Fetches messages from Microsoft Graph, stores as interactions,
// derives stage/action, and runs all safeguards:
//   - Direct conversation filter (rep ↔ lead only)
//   - Newsletter guard (List-Unsubscribe)
//   - Bounce detection
//   - OOO detection
//   - Unsubscribe detection (human opt-out phrases only)
// ============================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getFreshOutlookToken } from "../_shared/outlookTokens.ts";
import { isOutOfOfficeReply, getOOOEligibleAt } from "../_shared/oooDetection.ts";

// ============================================
// CADENCE SETTINGS TYPES (shared with gmail-sync)
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
  | "NURTURE_CAMPAIGN_START"
  | "OOO_RETURN";

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

// ============================================
// CORS
// ============================================

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigins = Deno.env.get("ALLOWED_ORIGINS")?.split(",") || [];
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

// ============================================
// Graph API helpers
// ============================================

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface GraphMessage {
  id: string;
  conversationId: string;
  subject: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  from: { emailAddress: { address: string; name: string } };
  toRecipients: Array<{ emailAddress: { address: string; name: string } }>;
  ccRecipients?: Array<{ emailAddress: { address: string; name: string } }>;
  receivedDateTime: string;
  sentDateTime: string;
  internetMessageId: string;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  isDraft: boolean;
}

function extractEmailAddresses(headerValue: string): string[] {
  const emails: string[] = [];
  const emailRegex = /<([^>]+@[^>]+)>|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  let match;
  while ((match = emailRegex.exec(headerValue)) !== null) {
    const email = (match[1] || match[2]).toLowerCase().trim();
    if (email) emails.push(email);
  }
  return emails;
}

function htmlToPlainText(html: string): string {
  let text = html;
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<\/tr>/gi, "\n");
  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<\/h[1-6]>/gi, "\n\n");
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<[^>]+>/g, "");
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
  text = text.replace(/&#\d+;/g, "");
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function getGraphMessageBody(msg: GraphMessage): string {
  if (msg.body.contentType === "text") return msg.body.content || msg.bodyPreview || "";
  // HTML → plain text
  return htmlToPlainText(msg.body.content || "") || msg.bodyPreview || "";
}

function getInternetHeader(msg: GraphMessage, name: string): string | undefined {
  return msg.internetMessageHeaders?.find(
    h => h.name.toLowerCase() === name.toLowerCase()
  )?.value;
}

function containsClosingKeywords(text: string): boolean {
  const keywords = ["pricing", "contract", "procurement", "security review", "legal", "proposal", "quote", "budget"];
  const lowerText = text.toLowerCase();
  return keywords.some(kw => lowerText.includes(kw));
}

// ============================================
// deriveStage (identical to gmail-sync)
// ============================================

function deriveStage(
  currentStage: string,
  metrics: LeadMetrics,
  hasClosingKeywords: boolean
): string {
  if (currentStage === "closed_won" || currentStage === "closed_lost") return currentStage;
  if (hasClosingKeywords && metrics.last_inbound_at) return "closing";
  if (metrics.meeting_summary_count > 0) return "post_meeting";
  if (metrics.last_inbound_at && metrics.first_outbound_at) {
    if (new Date(metrics.last_inbound_at).getTime() > new Date(metrics.first_outbound_at).getTime()) return "engaged";
  }
  if (metrics.first_outbound_at) return "contacted";
  return "new";
}

// ============================================
// deriveAction (identical to gmail-sync)
// ============================================

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
  strategy: string,
  motion: string = "outbound_prospecting"
): ActionResult & { auto_nurture_eligible?: boolean } {
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  // STOP/PAUSE RULES
  if (stopPauseRules.pause_when_meeting_scheduled && hasFutureMeeting) {
    return { needs_action: false, next_action_key: "paused_meeting_scheduled", next_action_label: "Paused - meeting scheduled", eligible_at: null, action_reason_code: null };
  }

  // GUARDRAILS
  if (recentOutbound7d >= guardrails.max_emails_per_lead_per_7d) {
    return { needs_action: false, next_action_key: null, next_action_label: null, eligible_at: null, action_reason_code: null };
  }
  if (recentOutbound30d >= guardrails.max_emails_per_lead_per_30d) {
    return { needs_action: false, next_action_key: null, next_action_label: null, eligible_at: null, action_reason_code: null };
  }

  const lastOutTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
  const hoursSinceLastOut = (now - lastOutTime) / HOUR;

  if (hoursSinceLastOut < guardrails.min_gap_hours_between_emails && lastOutTime > 0) {
    const eligibleTime = lastOutTime + (guardrails.min_gap_hours_between_emails * HOUR);
    return { needs_action: false, next_action_key: null, next_action_label: null, eligible_at: new Date(eligibleTime).toISOString(), action_reason_code: null };
  }

  if (!guardrails.same_day_send_allowed && lastOutTime > 0) {
    if (new Date(lastOutTime).toDateString() === new Date(now).toDateString()) {
      return { needs_action: false, next_action_key: null, next_action_label: null, eligible_at: null, action_reason_code: null };
    }
  }

  // A) REPLY PENDING
  if (metrics.last_inbound_at) {
    const inboundTime = new Date(metrics.last_inbound_at).getTime();
    const outboundTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
    if (inboundTime > outboundTime) {
      const elapsed = now - inboundTime;
      const thresholdMs = modeSettings.reply_pending_hours * HOUR;
      if (elapsed > thresholdMs) {
        const jitter = getDeterministicJitter(leadId, "reply_now", guardrails.jitter_percent);
        const eligibleAt = new Date(inboundTime + thresholdMs * (1 + jitter));
        return { needs_action: true, next_action_key: "reply_now", next_action_label: "Reply to customer", eligible_at: eligibleAt.toISOString(), action_reason_code: "REPLY_PENDING" };
      }
    }
  }

  // STOP RULES
  if (stopPauseRules.stop_on_any_reply && metrics.last_inbound_at) {
    const inboundTime = new Date(metrics.last_inbound_at).getTime();
    const outboundTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
    if (inboundTime > outboundTime) {
      return { needs_action: false, next_action_key: "wait_reply_threshold", next_action_label: "Waiting for reply threshold", eligible_at: null, action_reason_code: null };
    }
  }

  // B) CLOSING STAGE
  if (stage === "closing") {
    if (now - lastOutTime > 3 * DAY) {
      const jitter = getDeterministicJitter(leadId, "closing_followup", guardrails.jitter_percent);
      const eligibleAt = new Date(lastOutTime + (3 * DAY) * (1 + jitter));
      return { needs_action: true, next_action_key: "closing_followup", next_action_label: "Follow up on proposal/contract", eligible_at: eligibleAt.toISOString(), action_reason_code: "CLOSING_FOLLOWUP_DUE" };
    }
  }

  // C) PRE-MEETING FOLLOW-UP
  if (motion !== "nurture" && metrics.first_outbound_at && !metrics.last_inbound_at && metrics.meeting_summary_count === 0) {
    const firstOutTime = new Date(metrics.first_outbound_at).getTime();
    const daysSinceFirst = (now - firstOutTime) / DAY;
    const daysSinceLast = (now - lastOutTime) / DAY;
    const breakupTrigger = modeSettings.breakup_trigger;
    const followupDays = modeSettings.outbound_followups_days;

    // NURTURE SWITCH CHECK
    if (strategy === "fast" && daysSinceFirst >= breakupTrigger.days_since_first_outbound * 0.8) {
      let estimatedFollowups = 0;
      let cumDays = 0;
      for (const days of followupDays) {
        cumDays += days;
        if (daysSinceFirst >= cumDays) estimatedFollowups++;
      }
      if (estimatedFollowups >= 3) {
        return { needs_action: true, next_action_key: "switch_to_nurture", next_action_label: "Consider switching to nurture mode", eligible_at: new Date(now).toISOString(), action_reason_code: "NURTURE_SWITCH_RECOMMENDED", auto_nurture_eligible: true };
      }
    }

    // Breakup
    if (daysSinceFirst >= breakupTrigger.days_since_first_outbound && daysSinceLast >= breakupTrigger.days_since_last_outbound) {
      const jitter = getDeterministicJitter(leadId, "send_pre_4", guardrails.jitter_percent);
      const eligibleAt = new Date(lastOutTime + (breakupTrigger.days_since_last_outbound * DAY) * (1 + jitter));
      return { needs_action: true, next_action_key: "send_pre_4", next_action_label: "Send breakup email", eligible_at: eligibleAt.toISOString(), action_reason_code: "BREAKUP_DUE" };
    }

    // Follow-ups
    let cumulativeDays = 0;
    for (let i = 0; i < followupDays.length; i++) {
      cumulativeDays += followupDays[i];
      const nextStepIndex = i + 2;
      if (nextStepIndex > 4) break;
      if (daysSinceFirst >= cumulativeDays && daysSinceLast >= followupDays[i]) {
        const jitter = getDeterministicJitter(leadId, `send_pre_${nextStepIndex}`, guardrails.jitter_percent);
        const eligibleAt = new Date(lastOutTime + (followupDays[i] * DAY) * (1 + jitter));
        return { needs_action: true, next_action_key: `send_pre_${nextStepIndex}`, next_action_label: nextStepIndex === 4 ? "Send breakup email" : `Send follow-up Email ${nextStepIndex}`, eligible_at: eligibleAt.toISOString(), action_reason_code: "FOLLOWUP_DUE" };
      }
    }
  }

  // D) POST-MEETING RECAP
  if (hasMeetingWithoutFollowup) {
    return { needs_action: true, next_action_key: "generate_post_meeting_recap", next_action_label: "Send post-meeting recap", eligible_at: new Date(now).toISOString(), action_reason_code: "POST_MEETING_RECAP_DUE" };
  }

  // D2) POST-MEETING FOLLOW-UP
  if (stage === "post_meeting" && !hasMeetingWithoutFollowup) {
    const lastOutboundTime = metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0;
    const lastInboundTime = metrics.last_inbound_at ? new Date(metrics.last_inbound_at).getTime() : 0;
    if (lastOutboundTime > 0 && lastOutboundTime > lastInboundTime) {
      const daysSinceOutbound = (now - lastOutboundTime) / DAY;
      if (daysSinceOutbound >= 7) {
        const jitter = getDeterministicJitter(leadId, "post_meeting_followup", guardrails.jitter_percent);
        const eligibleAt = new Date(lastOutboundTime + (7 * DAY) * (1 + jitter));
        return { needs_action: true, next_action_key: "post_meeting_followup", next_action_label: "Follow up (no response in 7 days)", eligible_at: eligibleAt.toISOString(), action_reason_code: "POST_MEETING_FOLLOWUP_DUE" };
      }
    }
  }

  // E) NURTURE
  if (flows.nurture_campaigns.enabled && metrics.nurture_outbound_count > 0 && nurtureCadence) {
    const lastNurtureTime = metrics.last_nurture_outbound_at ? new Date(metrics.last_nurture_outbound_at).getTime() : 0;
    const cadenceDays = flows.nurture_campaigns.cadences_days;
    let intervalDays = cadenceDays.weekly;
    if (nurtureCadence === "biweekly") intervalDays = cadenceDays.biweekly;
    else if (nurtureCadence === "monthly") intervalDays = cadenceDays.monthly;
    if ((now - lastNurtureTime) / DAY >= intervalDays) {
      const jitter = getDeterministicJitter(leadId, `send_nurture_${metrics.nurture_outbound_count + 1}`, guardrails.jitter_percent);
      const eligibleAt = new Date(lastNurtureTime + (intervalDays * DAY) * (1 + jitter));
      return { needs_action: true, next_action_key: `send_nurture_${metrics.nurture_outbound_count + 1}`, next_action_label: "Send nurture email", eligible_at: eligibleAt.toISOString(), action_reason_code: "NURTURE_DUE" };
    }
  }

  // F) RE-ENGAGEMENT
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
        return { needs_action: true, next_action_key: "reengage", next_action_label: "Re-engage cold lead", eligible_at: eligibleAt.toISOString(), action_reason_code: "REENGAGE_DUE" };
      }
    }
  }

  return { needs_action: false, next_action_key: null, next_action_label: null, eligible_at: null, action_reason_code: null };
}

// ============================================
// LeadUpdate interface
// ============================================

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
  action_dismissed_at?: string | null;
}

// ============================================
// MAIN HANDLER
// ============================================

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, error: "Missing authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
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
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { leadId, leadEmail, maxResults = 20 } = await req.json();
    const leadEmailNorm = typeof leadEmail === "string" ? leadEmail.trim().toLowerCase() : "";

    if (!leadId || !leadEmailNorm) {
      return new Response(JSON.stringify({ ok: false, error: "Missing leadId or leadEmail" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceSupabase = createClient(supabaseUrl, supabaseServiceKey);

    // Find the Outlook mail_account for this user's workspace
    // First get the user's workspace
    const { data: membership } = await supabase
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();

    if (!membership) {
      return new Response(JSON.stringify({ ok: false, error: "No workspace found" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: mailAccount } = await serviceSupabase
      .from("mail_accounts")
      .select("*")
      .eq("workspace_id", membership.workspace_id)
      .eq("provider", "outlook")
      .eq("status", "connected")
      .order("is_default", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!mailAccount) {
      return new Response(JSON.stringify({ ok: false, error: "Outlook not connected" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get current lead data
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

    // Get fresh access token
    let accessToken: string;
    try {
      accessToken = await getFreshOutlookToken(mailAccount.id, serviceSupabase);
    } catch (tokenErr) {
      const errMsg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
      const needsReconnect = errMsg.includes("expired") || errMsg.includes("reauthorize");
      return new Response(JSON.stringify({ ok: false, error: errMsg, needsReconnect }), {
        status: needsReconnect ? 200 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const repEmail = (mailAccount.email_address || "").toLowerCase().trim();

    // Search messages involving the lead email (30 days before lead creation)
    const leadCreatedAt = leadData?.created_at ? new Date(leadData.created_at) : new Date();
    const syncStartDate = new Date(leadCreatedAt);
    syncStartDate.setDate(syncStartDate.getDate() - 30);
    const syncStartMs = syncStartDate.getTime();
    const filterDate = syncStartDate.toISOString();

    // Graph API: search for messages to/from lead email, requesting internet headers
    const filter = `(from/emailAddress/address eq '${leadEmailNorm}' or (toRecipients/any(r: r/emailAddress/address eq '${leadEmailNorm}'))) and receivedDateTime ge ${filterDate}`;
    const graphUrl = `${GRAPH_BASE}/me/messages?$filter=${encodeURIComponent(filter)}&$top=${maxResults}&$orderby=receivedDateTime desc&$select=id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,internetMessageId,isDraft,internetMessageHeaders`;

    const searchResp = await fetch(graphUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.body-content-type="text"' },
    });

    if (!searchResp.ok) {
      const errorText = await searchResp.text();
      console.error("[outlook-sync] Search failed:", errorText);
      const needsReconnect = searchResp.status === 401 || searchResp.status === 403;
      return new Response(JSON.stringify({
        ok: false,
        error: needsReconnect ? "Outlook permissions need updating - please reauthorize" : "Outlook search failed",
        needsReconnect,
      }), {
        status: needsReconnect ? 200 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const searchData = await searchResp.json();
    const messages: GraphMessage[] = searchData.value || [];

    console.log(`[outlook-sync] Found ${messages.length} messages for ${leadEmailNorm}`);

    // Get existing message IDs for dedup (use internetMessageId as the stable key)
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

    for (const msg of messages) {
      // Use internetMessageId as stable dedup key (falls back to Graph id)
      const messageId = msg.internetMessageId || msg.id;
      if (existingMessageIds.has(messageId)) continue;
      if (msg.isDraft) continue;

      try {
        const fromEmail = msg.from?.emailAddress?.address?.toLowerCase().trim() || "";
        const toEmails = (msg.toRecipients || []).map(r => r.emailAddress?.address?.toLowerCase().trim()).filter(Boolean);

        // STRICT DIRECTION FILTER: Only direct rep ↔ lead conversation
        const isFromLead = fromEmail === leadEmailNorm;
        const isFromRep = fromEmail === repEmail;
        const isToLead = toEmails.includes(leadEmailNorm);
        const isToRep = toEmails.includes(repEmail);
        const isDirectConversation = (isFromLead && isToRep) || (isFromRep && isToLead);

        if (!isDirectConversation) {
          console.log(`[outlook-sync] Skipping 3rd-party message ${msg.id} (from: "${fromEmail}", to: "${toEmails.join(",")}")`);
          continue;
        }

        // Server-side date guard
        const msgTimestamp = new Date(msg.receivedDateTime).getTime();
        if (msgTimestamp < syncStartMs) continue;

        const subject = msg.subject || "(no subject)";
        const occurredAt = msg.sentDateTime || msg.receivedDateTime;
        const direction = isFromLead ? "inbound" : "outbound";
        const type = isFromLead ? "email_inbound" : "email_outbound";
        const bodyText = getGraphMessageBody(msg);

        // Convert internet headers to array format for OOO detection
        const headersArr = (msg.internetMessageHeaders || []).map(h => ({ name: h.name, value: h.value }));

        // Closing keywords
        if (direction === "inbound" && containsClosingKeywords(bodyText + " " + subject)) {
          hasClosingKeywords = true;
        }

        // BOUNCE detection
        const fromLower = fromEmail;
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
          console.log(`[outlook-sync] Lead ${leadId}: Bounce detected — stopping automation`);
          await serviceSupabase.from("leads").update({
            unsubscribed: true, needs_action: false, eligible_at: null,
            next_action_key: null, next_action_label: null, action_reason_code: null,
            nurture_status: "inactive",
          }).eq("id", leadId);

          await serviceSupabase.from("interactions").insert({
            lead_id: leadId, type: "system_note", source: "automation",
            body_text: `Email bounced/undeliverable (subject: "${subject}") — automation stopped permanently.`,
            occurred_at: new Date().toISOString(),
          });
        }

        // OOO detection
        if (direction === "inbound" && !isBounce) {
          const oooResult = isOutOfOfficeReply(headersArr, subject, bodyText);
          if (oooResult.isOOO) {
            const eligibleAt = getOOOEligibleAt(oooResult.returnDate);
            const returnDateStr = oooResult.returnDate
              ? oooResult.returnDate.toLocaleDateString("en-US", { month: "long", day: "numeric" })
              : "approximately 7 days";

            console.log(`[outlook-sync] Lead ${leadId}: OOO detected (${oooResult.confidence}). Pausing until ${eligibleAt}`);

            await serviceSupabase.from("leads").update({
              ooo_until: oooResult.returnDate ? oooResult.returnDate.toISOString() : eligibleAt,
              eligible_at: eligibleAt, needs_action: false,
              next_action_key: null, next_action_label: null, action_reason_code: null,
            }).eq("id", leadId);

            await serviceSupabase.from("interactions").insert({
              lead_id: leadId, type: "system_note", source: "automation",
              body_text: `📵 OOO auto-reply detected (${oooResult.confidence} signal). Returning ${returnDateStr}. Automation paused.`,
              occurred_at: occurredAt,
              gmail_message_id: messageId,
              gmail_thread_id: msg.conversationId,
            });

            existingMessageIds.add(messageId);
            synced++;
            continue;
          }
        }

        // UNSUBSCRIBE detection (human opt-out only, skip newsletters)
        const hasListUnsubscribeHeader = !!getInternetHeader(msg, "List-Unsubscribe");
        if (direction === "inbound" && !hasListUnsubscribeHeader) {
          const bodyLower = bodyText.toLowerCase();
          if (/\bstop\s+emailing\b/.test(bodyLower) || /\bremove\s+me\b/.test(bodyLower) || /\bplease\s+(don['']t|do\s+not|stop)\s+(email|contact|reach)\b/.test(bodyLower)) {
            console.log(`[outlook-sync] Lead ${leadId}: Unsubscribe keyword detected`);
            await serviceSupabase.from("leads").update({
              unsubscribed: true, needs_action: false, eligible_at: null,
              next_action_key: null, next_action_label: null, action_reason_code: null,
              nurture_status: "inactive",
            }).eq("id", leadId);

            await serviceSupabase.from("interactions").insert({
              lead_id: leadId, type: "system_note", source: "automation",
              body_text: "Lead requested to unsubscribe — automation stopped permanently.",
              occurred_at: new Date().toISOString(),
            });
          }
        }

        // Insert interaction
        const { error: insertError } = await serviceSupabase
          .from("interactions")
          .insert({
            lead_id: leadId,
            type,
            source: "outlook",
            occurred_at: occurredAt,
            subject,
            from_email: msg.from?.emailAddress?.address || "",
            to_email: toEmails.join(", "),
            body_text: bodyText.substring(0, 10000),
            gmail_message_id: messageId,
            gmail_thread_id: msg.conversationId,
            direction,
          });

        if (insertError) {
          if (!insertError.message.includes("duplicate")) {
            errors.push(`Failed to insert message ${msg.id}: ${insertError.message}`);
          }
        } else {
          synced++;
          existingMessageIds.add(messageId);
        }
      } catch (err) {
        errors.push(`Error processing message ${msg.id}: ${err instanceof Error ? err.message : "Unknown"}`);
      }
    }

    // ============================================
    // COMPUTE DERIVED METRICS (identical logic to gmail-sync)
    // ============================================

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
          .select("id")
          .eq("lead_id", leadId)
          .eq("direction", "outbound")
          .gt("occurred_at", referenceDate)
          .limit(1);
        if (postMeetingEmails && postMeetingEmails.length > 0) {
          await serviceSupabase
            .from("meeting_packs")
            .update({ follow_up_email_body: "[Sent via Outlook]", follow_up_email_subject: "Follow-up" })
            .eq("id", mp.id);
          continue;
        }
      }
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
      if (interaction.type === "system_note") continue;
      const dir = interaction.direction || (interaction.type?.includes("inbound") ? "inbound" : "outbound");
      const occurredAt = interaction.occurred_at;
      const bodyLower = (interaction.body_text || "").toLowerCase();

      if (dir === "outbound") {
        if (!metrics.first_outbound_at) metrics.first_outbound_at = occurredAt;
        metrics.last_outbound_at = occurredAt;
        if (bodyLower.includes("nurture") || interaction.type === "nurture_email") {
          metrics.nurture_outbound_count++;
          metrics.last_nurture_outbound_at = occurredAt;
        }
      } else if (dir === "inbound") {
        metrics.last_inbound_at = occurredAt;
        if (containsClosingKeywords(interaction.body_text || "")) hasClosingKeywords = true;
      }
    }

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

    // Derive stage and action
    const stage = deriveStage(currentStage, metrics, hasClosingKeywords);
    const actionResult = deriveAction(
      leadId, metrics, nurtureCadence, stage, hasMeetingWithoutFollowup, hasFutureMeeting,
      recentOutbound7d, recentOutbound30d, modeSettings, cadenceSettings.guardrails,
      cadenceSettings.stop_pause_rules, cadenceSettings.flows, timezone, strategy, leadMotion
    );

    // ============================================
    // DISMISSAL CHECK
    // ============================================
    const dismissedAt = actionDismissedAt ? new Date(actionDismissedAt).getTime() : 0;
    const lastInteractionTime = Math.max(
      metrics.last_outbound_at ? new Date(metrics.last_outbound_at).getTime() : 0,
      metrics.last_inbound_at ? new Date(metrics.last_inbound_at).getTime() : 0
    );

    let finalAction = actionResult;
    let shouldClearDismissal = false;

    if (dismissedAt > 0 && dismissedAt > lastInteractionTime) {
      finalAction = { needs_action: false, next_action_key: null, next_action_label: null, eligible_at: null, action_reason_code: null, auto_nurture_eligible: actionResult.auto_nurture_eligible };
    } else if (dismissedAt > 0 && lastInteractionTime > dismissedAt) {
      shouldClearDismissal = true;
    }

    // Check active automation/nurture/OOO
    const { data: currentLeadState } = await serviceSupabase
      .from("leads")
      .select("eligible_at, needs_action, motion, nurture_status, ooo_until")
      .eq("id", leadId)
      .single();

    const hasActiveSequence = currentLeadState?.needs_action === true
      && currentLeadState?.eligible_at
      && new Date(currentLeadState.eligible_at).getTime() > Date.now();
    const hasActiveNurture = currentLeadState?.motion === "nurture" && currentLeadState?.nurture_status === "active";
    const hasActiveOOO = !!currentLeadState?.ooo_until && new Date(currentLeadState.ooo_until).getTime() > Date.now();
    const hasActiveAutomation = hasActiveSequence || hasActiveNurture;

    // Build update
    const leadUpdate: LeadUpdate & { auto_nurture_eligible?: boolean } = {
      stage,
      needs_action: hasActiveAutomation ? currentLeadState!.needs_action : finalAction.needs_action,
      next_action_key: hasActiveAutomation ? undefined as any : finalAction.next_action_key,
      next_action_label: hasActiveAutomation ? undefined as any : finalAction.next_action_label,
      eligible_at: hasActiveAutomation ? currentLeadState!.eligible_at : finalAction.eligible_at,
      action_reason_code: hasActiveAutomation ? undefined as any : finalAction.action_reason_code,
      first_outbound_at: metrics.first_outbound_at,
      last_outbound_at: metrics.last_outbound_at,
      last_inbound_at: hasActiveOOO ? undefined as any : metrics.last_inbound_at,
      meeting_summary_count: metrics.meeting_summary_count,
      nurture_outbound_count: metrics.nurture_outbound_count,
      last_nurture_outbound_at: metrics.last_nurture_outbound_at,
      last_activity_at: new Date().toISOString(),
    };

    if (hasActiveNurture) {
      delete (leadUpdate as Record<string, unknown>).needs_action;
      delete (leadUpdate as Record<string, unknown>).next_action_key;
      delete (leadUpdate as Record<string, unknown>).next_action_label;
      delete (leadUpdate as Record<string, unknown>).eligible_at;
      delete (leadUpdate as Record<string, unknown>).action_reason_code;
    }

    if (hasActiveOOO) {
      delete (leadUpdate as Record<string, unknown>).needs_action;
      delete (leadUpdate as Record<string, unknown>).next_action_key;
      delete (leadUpdate as Record<string, unknown>).next_action_label;
      delete (leadUpdate as Record<string, unknown>).eligible_at;
      delete (leadUpdate as Record<string, unknown>).action_reason_code;
      delete (leadUpdate as Record<string, unknown>).last_inbound_at;
    }

    if (shouldClearDismissal) leadUpdate.action_dismissed_at = null;
    if (finalAction.auto_nurture_eligible !== undefined) leadUpdate.auto_nurture_eligible = finalAction.auto_nurture_eligible;

    await serviceSupabase.from("leads").update(leadUpdate).eq("id", leadId);

    // Update last_sync_at
    await serviceSupabase.from("mail_accounts").update({ last_sync_at: new Date().toISOString() }).eq("id", mailAccount.id);

    console.log(`[outlook-sync] Synced ${synced} messages, stage=${stage}, needs_action=${actionResult.needs_action}`);

    return new Response(
      JSON.stringify({
        ok: true, synced, total: messages.length, stage,
        needs_action: actionResult.needs_action,
        next_action_key: actionResult.next_action_key,
        eligible_at: actionResult.eligible_at,
        action_reason_code: actionResult.action_reason_code,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorId = crypto.randomUUID();
    const errorMessage = error instanceof Error ? error.message : "An error occurred while syncing emails";
    const needsReconnect =
      errorMessage.toLowerCase().includes("expired") ||
      errorMessage.toLowerCase().includes("revoked") ||
      errorMessage.toLowerCase().includes("reauthorize") ||
      errorMessage.toLowerCase().includes("permissions");

    console.error(`[outlook-sync] Error ${errorId}:`, error);
    return new Response(
      JSON.stringify({ ok: false, error: errorMessage, error_id: errorId, needsReconnect }),
      {
        status: needsReconnect ? 200 : 500,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      }
    );
  }
});
