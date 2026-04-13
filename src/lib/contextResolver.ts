// Context Resolver — fetches and assembles all lead context for draft generation
import type { LeadDetail, MeetingPackItem, EmailThreadItem, InteractionItem, TimelineItem } from "@/lib/supabaseQueries";
import { getLeadDetail, getLeadEmailThread, getLeadMeetingPacks, getLeadInteractions, getLeadTimeline } from "@/lib/supabaseQueries";
import { getRepProfile, getKnowledgeDocuments, type RepProfile, type KnowledgeDocument } from "@/lib/repProfileQueries";
import { getWorkspaceProfile, type WorkspaceProfile } from "@/lib/workspaceProfileQueries";
import { calculateClosingPower, SIGNAL_PATTERNS } from "@/lib/closingPowerUtils";
import type { Motion, SourceType } from "@/lib/dashboardUtils";
import { supabase } from "@/integrations/supabase/client";

// ============================================
// TYPES
// ============================================

export interface ResolvedContext {
  // Lead core
  lead: LeadDetail;
  source_type: SourceType;
  motion: Motion;
  strategy: string;
  stage: string;
  status: string;

  // Sequence state (derived)
  sequence_type: string;
  sequence_step: number;
  sequence_status: "active" | "completed" | "paused";

  // Email history
  last_outbound_email: EmailThreadItem | null;
  last_inbound_email: EmailThreadItem | null;
  thread_emails: EmailThreadItem[];
  thread_summary: string;

  // Cross-channel conversation history (all channels: email, sms, whatsapp, etc.)
  cross_channel_summary: string;
  last_inbound_any_channel: { channel: string; snippet: string; occurred_at: string } | null;

  // Meeting data
  last_meeting_summary: MeetingPackItem | null;
  meeting_packs: MeetingPackItem[];
  has_unsent_recap: boolean;

  // Intelligence
  buying_signals: string[];
  risk_signals: string[];

  // Engagement
  engagement_level: "hot" | "warm" | "cold" | "stale";
  closing_power: number;

  // Knowledge
  company_kb: unknown;
  industry_kb: unknown;
  persona_kb: KnowledgeDocument[];

  // Nurture state
  nurture_mode: "review" | "automatic" | null;
  nurture_status: "active" | "paused" | "inactive";
  nurture_theme: string | null;
  nurture_cadence: string | null;
  nurture_outbound_count: number;

  // Profiles
  rep_profile: RepProfile | null;
  workspace_profile: WorkspaceProfile | null;
}

// ============================================
// SIGNAL EXTRACTION
// ============================================

interface Milestone {
  description: string;
  status: "completed" | "pending";
  date: string | null;
}

interface Risk {
  issue: string;
  level: "low" | "medium" | "high";
}

function extractBuyingSignals(milestones: Milestone[]): string[] {
  const signals: string[] = [];
  const allText = milestones.map(m => m.description).join(" ");

  if (SIGNAL_PATTERNS.pricing.test(allText)) signals.push("pricing_discussed");
  if (SIGNAL_PATTERNS.decision_maker.test(allText)) signals.push("decision_maker_involved");
  if (SIGNAL_PATTERNS.docs_requested.test(allText)) signals.push("docs_requested");

  const completed = milestones.filter(m => m.status === "completed").length;
  if (completed >= 3) signals.push("multiple_milestones_completed");

  return signals;
}

function extractRiskSignals(risks: Risk[]): string[] {
  return risks.map(r => `${r.level}: ${r.issue}`);
}

// ============================================
// SEQUENCE DERIVATION
// ============================================

function deriveSequenceType(motion: Motion, actionKey: string | null): string {
  if (motion === "nurture") return "nurture";
  if (motion === "post_meeting") return "post_meeting";
  if (motion === "closing") return "closing";
  if (motion === "inbound_response") return "inbound_response";

  // Outbound prospecting sequence
  if (actionKey?.startsWith("send_pre_")) return "outbound_prospecting";
  if (actionKey === "reply_now") return "inbound_response";
  if (actionKey === "generate_post_meeting_recap" || actionKey === "post_meeting_followup") return "post_meeting";

  return motion || "outbound_prospecting";
}

function deriveSequenceStep(actionKey: string | null): number {
  if (!actionKey) return 0;
  if (actionKey.startsWith("send_pre_1")) return 1;
  if (actionKey.startsWith("send_pre_2")) return 2;
  if (actionKey.startsWith("send_pre_3")) return 3;
  if (actionKey.startsWith("send_pre_4")) return 4;
  if (actionKey.startsWith("send_nurture_")) {
    const match = actionKey.match(/send_nurture_(\d+)/);
    return match ? parseInt(match[1], 10) : 1;
  }
  return 0;
}

function deriveSequenceStatus(lead: LeadDetail): "active" | "completed" | "paused" {
  if (lead.has_future_meeting) return "paused";
  if (lead.stage === "closed_won" || lead.stage === "closed_lost") return "completed";
  return "active";
}

// ============================================
// ENGAGEMENT LEVEL
// ============================================

function deriveEngagementLevel(lead: LeadDetail, closingPower: number): "hot" | "warm" | "cold" | "stale" {
  if (closingPower >= 60) return "hot";
  if (closingPower >= 35) return "warm";

  if (!lead.last_activity_at) return "stale";
  const daysSince = (Date.now() - new Date(lead.last_activity_at).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince > 14) return "stale";
  if (daysSince > 7) return "cold";
  return "warm";
}

// ============================================
// THREAD DATE ANNOTATION
// ============================================

function annotateThreadWithDates(emails: EmailThreadItem[], summary: string): string {
  if (!emails.length || !summary) return summary;

  const now = Date.now();
  // Build a mapping of email snippets to relative dates
  const dateAnnotations: string[] = [];
  for (const email of emails) {
    if (!email.occurred_at) continue;
    const daysAgo = Math.floor((now - new Date(email.occurred_at).getTime()) / (1000 * 60 * 60 * 24));
    const direction = email.direction === "outbound" ? "OUTBOUND" : "INBOUND";
    const dateStr = new Date(email.occurred_at).toISOString().split("T")[0];
    const relativeStr = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;
    dateAnnotations.push(`[${direction} ${dateStr} (${relativeStr})]`);
  }

  // Prepend a temporal context header to the thread summary
  const header = `=== EMAIL THREAD TIMELINE (most recent first) ===\n${dateAnnotations.join("\n")}\n===\n\n`;
  return header + summary;
}

// ============================================
// MAIN RESOLVER
// ============================================

export interface ContextPrefetched {
  repProfile?: RepProfile | null;
  workspaceProfile?: WorkspaceProfile | null;
  knowledgeDocs?: KnowledgeDocument[];
}

export async function contextResolver(leadId: string, prefetched?: ContextPrefetched): Promise<ResolvedContext> {
  // Parallel fetch all data — skip anything already prefetched by the caller
  const needsRepProfile = !prefetched || prefetched.repProfile === undefined;
  const needsWorkspaceProfile = !prefetched || prefetched.workspaceProfile === undefined;
  const needsKnowledgeDocs = !prefetched || prefetched.knowledgeDocs === undefined;

  const [
    lead,
    emailThread,
    meetingPacks,
    interactions,
    repProfile,
    workspaceProfile,
    knowledgeDocs,
  ] = await Promise.all([
    getLeadDetail(leadId),
    getLeadEmailThread(leadId, 10),
    getLeadMeetingPacks(leadId),
    getLeadInteractions(leadId),
    needsRepProfile ? getRepProfile().catch(() => null) : Promise.resolve(prefetched!.repProfile ?? null),
    needsWorkspaceProfile ? getWorkspaceProfile().catch(() => null) : Promise.resolve(prefetched!.workspaceProfile ?? null),
    needsKnowledgeDocs ? getKnowledgeDocuments().catch(() => [] as KnowledgeDocument[]) : Promise.resolve(prefetched!.knowledgeDocs ?? [] as KnowledgeDocument[]),
  ]);

  const motion = (lead.motion as Motion) || "outbound_prospecting";
  const sourceType = (lead.source_type as SourceType) || "manual_entry";

  // Extract emails
  const lastOutbound = emailThread.emails.find(e => e.direction === "outbound") || null;
  const lastInbound = emailThread.emails.find(e => e.direction === "inbound") || null;

  // Meeting analysis
  const lastMeeting = meetingPacks[0] || null;
  const hasUnsentRecap = lastMeeting
    ? !lastMeeting.follow_up_email_body
    : false;

  // Intelligence — prefer canonical lead_intelligence, fall back to legacy leads fields
  let milestones: Milestone[] = [];
  let risks: Risk[] = [];
  try {
    const { data: intel } = await supabase
      .from("lead_intelligence")
      .select("milestones_json, risks_json, objections_json, buying_signals_json")
      .eq("lead_id", leadId)
      .maybeSingle();
    if (intel) {
      milestones = intel.milestones_json
        ? (intel.milestones_json as unknown as Milestone[])
        : [];
      risks = intel.risks_json
        ? (intel.risks_json as unknown as Risk[])
        : [];
    } else {
      // Legacy fallback — leads table fields
      milestones = lead.milestones_json
        ? (lead.milestones_json as unknown as Milestone[])
        : [];
      risks = lead.risks_json
        ? (lead.risks_json as unknown as Risk[])
        : [];
    }
  } catch {
    // Legacy fallback on error
    milestones = lead.milestones_json
      ? (lead.milestones_json as unknown as Milestone[])
      : [];
    risks = lead.risks_json
      ? (lead.risks_json as unknown as Risk[])
      : [];
  }

  const buyingSignals = extractBuyingSignals(milestones);
  const riskSignals = extractRiskSignals(risks);

  // Engagement
  const cpResult = calculateClosingPower(lead);

  // Knowledge from workspace
  const companyKb = workspaceProfile ? (workspaceProfile as any).company_kb || null : null;
  const industryKb = workspaceProfile ? (workspaceProfile as any).industry_pack || null : null;

  // Annotate thread summary with relative dates for AI temporal awareness
  const annotatedThreadSummary = annotateThreadWithDates(emailThread.emails, emailThread.threadSummary);

  const resolved: ResolvedContext = {
    lead,
    source_type: sourceType,
    motion,
    strategy: lead.strategy,
    stage: lead.stage,
    status: lead.status,

    sequence_type: deriveSequenceType(motion, lead.next_action_key),
    sequence_step: deriveSequenceStep(lead.next_action_key),
    sequence_status: deriveSequenceStatus(lead),

    last_outbound_email: lastOutbound,
    last_inbound_email: lastInbound,
    thread_emails: emailThread.emails,
    thread_summary: annotatedThreadSummary,

    last_meeting_summary: lastMeeting,
    meeting_packs: meetingPacks,
    has_unsent_recap: hasUnsentRecap,

    buying_signals: buyingSignals,
    risk_signals: riskSignals,

    engagement_level: deriveEngagementLevel(lead, cpResult.total),
    closing_power: cpResult.total,

    company_kb: companyKb,
    industry_kb: industryKb,
    persona_kb: knowledgeDocs,

    nurture_mode: ((lead as any).nurture_mode as "review" | "automatic") || null,
    nurture_status: ((lead as any).nurture_status as "active" | "paused" | "inactive") || "inactive",
    nurture_theme: ((lead as any).nurture_theme as string) || null,
    nurture_cadence: lead.nurture_cadence || null,
    nurture_outbound_count: (lead as any).nurture_outbound_count || 0,

    rep_profile: repProfile,
    workspace_profile: workspaceProfile,
  };

  console.log("[contextResolver] Resolved context for lead", leadId, {
    motion,
    sourceType,
    stage: lead.stage,
    sequenceType: resolved.sequence_type,
    sequenceStep: resolved.sequence_step,
    hasThread: emailThread.emails.length > 0,
    hasMeeting: meetingPacks.length > 0,
    hasUnsentRecap,
    buyingSignals,
    riskSignals: riskSignals.length,
    engagementLevel: resolved.engagement_level,
    closingPower: cpResult.total,
  });

  return resolved;
}
