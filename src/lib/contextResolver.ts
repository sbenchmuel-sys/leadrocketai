// Context Resolver — fetches and assembles all lead context for draft generation
import type { LeadDetail, MeetingPackItem, EmailThreadItem, InteractionItem } from "@/lib/supabaseQueries";
import { getLeadDetail, getLeadEmailThread, getLeadMeetingPacks, getLeadInteractions } from "@/lib/supabaseQueries";
import { getRepProfile, getKnowledgeDocuments, type RepProfile, type KnowledgeDocument } from "@/lib/repProfileQueries";
import { getWorkspaceProfile, type WorkspaceProfile } from "@/lib/workspaceProfileQueries";
import { calculateClosingPower, SIGNAL_PATTERNS } from "@/lib/closingPowerUtils";
import type { Motion, SourceType } from "@/lib/dashboardUtils";

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
// MAIN RESOLVER
// ============================================

export async function contextResolver(leadId: string): Promise<ResolvedContext> {
  // Parallel fetch all data
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
    getRepProfile().catch(() => null),
    getWorkspaceProfile().catch(() => null),
    getKnowledgeDocuments().catch(() => [] as KnowledgeDocument[]),
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

  // Intelligence
  const milestones: Milestone[] = lead.milestones_json
    ? (lead.milestones_json as unknown as Milestone[])
    : [];
  const risks: Risk[] = lead.risks_json
    ? (lead.risks_json as unknown as Risk[])
    : [];

  const buyingSignals = extractBuyingSignals(milestones);
  const riskSignals = extractRiskSignals(risks);

  // Engagement
  const cpResult = calculateClosingPower(lead);

  // Knowledge from workspace
  const companyKb = workspaceProfile ? (workspaceProfile as any).company_kb || null : null;
  const industryKb = workspaceProfile ? (workspaceProfile as any).industry_pack || null : null;

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
    thread_summary: emailThread.threadSummary,

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
