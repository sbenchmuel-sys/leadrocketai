// Dashboard utility functions for deriving stages and action requirements

import type { LeadListItem, InteractionItem } from "./supabaseQueries";

// Deal flow stages
export type DealStage = "new" | "contacted" | "engaged" | "post_meeting" | "closing";

export const STAGE_LABELS: Record<DealStage, string> = {
  new: "New",
  contacted: "Contacted",
  engaged: "Engaged",
  post_meeting: "Post-Meeting",
  closing: "Closing",
};

export const STAGE_ORDER: DealStage[] = ["new", "contacted", "engaged", "post_meeting", "closing"];

export interface LeadWithContext extends LeadListItem {
  stage: DealStage;
  needsAction: boolean;
  actionReason: string | null;
  actionType: "reply" | "follow_up" | "recap" | "view" | null;
  hasMeeting: boolean;
  interactionCount: number;
  hasInboundReply: boolean;
  pendingDraftCount: number;
}

export interface InteractionSummary {
  hasOutbound: boolean;
  hasInbound: boolean;
  hasMeeting: boolean;
  lastInboundNeedsReply: boolean;
  pendingDraftCount: number;
}

export function summarizeInteractions(
  interactions: InteractionItem[],
  drafts: { status: string }[]
): InteractionSummary {
  let hasOutbound = false;
  let hasInbound = false;
  let hasMeeting = false;
  let lastInboundNeedsReply = false;

  // Sort by occurred_at descending to find latest
  const sorted = [...interactions].sort(
    (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime()
  );

  for (const i of interactions) {
    const type = i.type?.toLowerCase() || "";
    const source = i.source?.toLowerCase() || "";
    const body = i.body_text?.toLowerCase() || "";

    // Detect outbound emails
    if (type === "email_sent" || source === "gmail_sent") {
      hasOutbound = true;
    }

    // Detect inbound emails
    if (type === "email_received" || source === "gmail_received" || i.ai_reply_worthy) {
      hasInbound = true;
    }

    // Detect meetings
    if (
      type === "meeting" ||
      type === "meeting_summary" ||
      body.includes("meeting") ||
      body.includes("call summary")
    ) {
      hasMeeting = true;
    }
  }

  // Check if latest interaction is inbound and needs reply
  if (sorted.length > 0) {
    const latest = sorted[0];
    const latestType = latest.type?.toLowerCase() || "";
    const latestSource = latest.source?.toLowerCase() || "";
    if (
      latestType === "email_received" ||
      latestSource === "gmail_received" ||
      latest.ai_reply_worthy
    ) {
      lastInboundNeedsReply = true;
    }
  }

  const pendingDraftCount = drafts.filter((d) => d.status === "pending" || d.status === "saved").length;

  return { hasOutbound, hasInbound, hasMeeting, lastInboundNeedsReply, pendingDraftCount };
}

export function deriveStage(
  lead: LeadListItem,
  summary: InteractionSummary
): DealStage {
  const status = lead.status?.toLowerCase() || "new";

  // Explicit closing statuses
  if (status === "closing" || status === "negotiating" || status === "proposal_sent") {
    return "closing";
  }

  if (status === "closed_won" || status === "closed_lost") {
    return "closing";
  }

  // Post-meeting if we have meeting data
  if (summary.hasMeeting) {
    return "post_meeting";
  }

  // Engaged if there's inbound communication
  if (summary.hasInbound) {
    return "engaged";
  }

  // Contacted if we've sent something
  if (summary.hasOutbound) {
    return "contacted";
  }

  return "new";
}

export function deriveNeedsAction(
  lead: LeadListItem,
  summary: InteractionSummary
): { needsAction: boolean; reason: string | null; actionType: LeadWithContext["actionType"] } {
  // Priority 1: Inbound email needs reply
  if (summary.lastInboundNeedsReply) {
    return {
      needsAction: true,
      reason: "Reply to customer",
      actionType: "reply",
    };
  }

  // Priority 2: Has next_step defined but no recent action
  if (lead.next_step) {
    return {
      needsAction: true,
      reason: lead.next_step,
      actionType: "follow_up",
    };
  }

  // Priority 3: Post-meeting but no recap
  if (summary.hasMeeting && summary.pendingDraftCount === 0) {
    // Could check for recap interaction, for now just suggest follow-up
    return {
      needsAction: true,
      reason: "Send post-meeting follow-up",
      actionType: "recap",
    };
  }

  // Priority 4: Contacted but no engagement yet
  if (summary.hasOutbound && !summary.hasInbound) {
    return {
      needsAction: true,
      reason: "Send follow-up",
      actionType: "follow_up",
    };
  }

  return { needsAction: false, reason: null, actionType: null };
}

export function enrichLeadWithContext(
  lead: LeadListItem,
  interactions: InteractionItem[],
  drafts: { status: string }[]
): LeadWithContext {
  const summary = summarizeInteractions(interactions, drafts);
  const stage = deriveStage(lead, summary);
  const { needsAction, reason, actionType } = deriveNeedsAction(lead, summary);

  return {
    ...lead,
    stage,
    needsAction,
    actionReason: reason,
    actionType,
    hasMeeting: summary.hasMeeting,
    interactionCount: interactions.length,
    hasInboundReply: summary.hasInbound,
    pendingDraftCount: summary.pendingDraftCount,
  };
}

// Get AI recommendation summary
export function getAIRecommendation(leads: LeadWithContext[]): string[] {
  const actionable = leads
    .filter((l) => l.needsAction)
    .sort((a, b) => {
      // Prioritize replies > follow-ups > recaps
      const priority: Record<string, number> = { reply: 1, recap: 2, follow_up: 3, view: 4 };
      return (priority[a.actionType || "view"] || 5) - (priority[b.actionType || "view"] || 5);
    })
    .slice(0, 3);

  return actionable.map((l) => {
    if (l.actionType === "reply") {
      return `Reply to ${l.name} at ${l.company} — they're waiting for your response.`;
    }
    if (l.actionType === "recap") {
      return `Send ${l.name} a post-meeting follow-up to keep momentum.`;
    }
    if (l.actionType === "follow_up") {
      return `Follow up with ${l.name} at ${l.company} — ${l.actionReason || "keep the conversation going"}.`;
    }
    return `Check in on ${l.name} at ${l.company}.`;
  });
}
