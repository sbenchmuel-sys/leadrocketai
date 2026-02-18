import { differenceInDays, differenceInHours, parseISO } from "date-fns";
import type { DealStage } from "@/lib/dashboardUtils";
import type { LeadDetail } from "@/lib/supabaseQueries";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

interface Milestone {
  description: string;
  status: "completed" | "pending";
  date: string | null;
}

interface Risk {
  issue: string;
  level: "low" | "medium" | "high";
}

export const SIGNAL_PATTERNS = {
  pricing: /pric|cost|quote|proposal/i,
  decision_maker: /decision.?maker|dm\b|c-level|ceo|cfo|cto|vp\b|director/i,
  docs_requested: /proposal|contract|agreement|sow\b|scope|nda/i,
};

export interface ScoreBreakdown {
  total: number;
  factors: { label: string; points: number }[];
}

export function calculateClosingPower(lead: LeadDetail): ScoreBreakdown {
  const factors: { label: string; points: number }[] = [];
  let score = 10;
  const stage = lead.stage as DealStage;
  const milestones: Milestone[] = lead.milestones_json ? (lead.milestones_json as unknown as Milestone[]) : [];
  const risks: Risk[] = lead.risks_json ? (lead.risks_json as unknown as Risk[]) : [];
  const allText = milestones.map(m => m.description).join(" ");

  // ── Core deal signals ──────────────────────────────────────
  if (lead.has_future_meeting || stage === "post_meeting" || stage === "closing") {
    factors.push({ label: "Meeting booked", points: 20 }); score += 20;
  }
  if (SIGNAL_PATTERNS.pricing.test(allText) || lead.deal_outlook === "positive") {
    factors.push({ label: "Pricing mentioned", points: 15 }); score += 15;
  }
  if (SIGNAL_PATTERNS.decision_maker.test(allText)) {
    factors.push({ label: "Decision maker involved", points: 15 }); score += 15;
  }
  if (SIGNAL_PATTERNS.docs_requested.test(allText)) {
    factors.push({ label: "Docs requested", points: 10 }); score += 10;
  }

  // ── Email reply speed ──────────────────────────────────────
  if (lead.last_inbound_at && lead.last_outbound_at) {
    const inbound = parseISO(lead.last_inbound_at).getTime();
    const outbound = parseISO(lead.last_outbound_at).getTime();
    const replyGapHours = Math.abs(inbound - outbound) / (1000 * 60 * 60);
    if (inbound > outbound && replyGapHours < 24) {
      factors.push({ label: "Fast reply (<24h)", points: 10 }); score += 10;
    } else if (inbound < outbound) {
      const d = differenceInDays(new Date(), parseISO(lead.last_outbound_at));
      if (d > 10) { factors.push({ label: "No reply after 10d", points: -15 }); score -= 15; }
      else if (d > 7) { factors.push({ label: "Slow reply (>7d)", points: -10 }); score -= 10; }
    }
  } else if (lead.last_outbound_at && !lead.last_inbound_at) {
    const d = differenceInDays(new Date(), parseISO(lead.last_outbound_at));
    if (d > 10) { factors.push({ label: "No reply after 10d", points: -15 }); score -= 15; }
  }

  // ── Risk penalties ─────────────────────────────────────────
  const riskPenalty = Math.min(risks.length * 5, 15);
  if (riskPenalty > 0) {
    factors.push({ label: `${risks.length} risk flag${risks.length > 1 ? "s" : ""}`, points: -riskPenalty });
    score -= riskPenalty;
  }
  if (stage === "closing") {
    factors.push({ label: "Closing stage", points: 10 }); score += 10;
  }

  // ── WhatsApp engagement signals ────────────────────────────
  // PART 1: Inbound WA received → +10 strong engagement signal
  // We detect via last_inbound_at + WA milestone hint or last_read_at presence
  const hasWaInbound = milestones.some(m => {
    const d = (m.description || "").toLowerCase();
    return d.includes("whatsapp") && (d.includes("reply") || d.includes("inbound") || d.includes("received"));
  });
  if (hasWaInbound) {
    factors.push({ label: "WhatsApp inbound reply", points: 10 }); score += 10;
  } else {
    // Fallback: any WA engagement in milestones
    const hasWaEngagement = milestones.some(m => (m.description || "").toLowerCase().includes("whatsapp"));
    if (hasWaEngagement) {
      factors.push({ label: "WhatsApp engaged", points: 5 }); score += 5;
    }
  }

  // PART 4: WA read receipt → +5 (lead opened our message)
  const lastReadAt = (lead as any).last_read_at as string | null;
  if (lastReadAt) {
    const hoursAgoRead = differenceInHours(new Date(), parseISO(lastReadAt));
    if (hoursAgoRead <= 48) {
      // Recent read — strong buying intent signal
      factors.push({ label: "WhatsApp message read", points: 5 }); score += 5;
    }
  }

  // PART 4: WA reply speed — if they replied on WA same day they received → +8
  // Proxy: last_read_at and last_inbound_at within 6h of each other signals fast WA engagement
  if (lastReadAt && lead.last_inbound_at) {
    const readGapH = Math.abs(
      parseISO(lastReadAt).getTime() - parseISO(lead.last_inbound_at).getTime()
    ) / (1000 * 60 * 60);
    if (readGapH <= 6) {
      factors.push({ label: "Fast WA engagement (<6h)", points: 8 }); score += 8;
    }
  }

  // PART 1 / PART 4: Conversation depth — 3+ WA exchanges → "warming" flag
  // Count WA interactions from milestones text (set by whatsapp-webhook bridge)
  const waExchangeCount = milestones.filter(m =>
    (m.description || "").toLowerCase().includes("whatsapp")
  ).length;
  if (waExchangeCount >= 3) {
    factors.push({ label: "WA conversation depth (3+)", points: 7 }); score += 7;
  }

  return { total: Math.max(0, Math.min(100, score)), factors };
}

export function getMomentum(lead: LeadDetail): { label: string; icon: typeof TrendingUp; color: string } {
  if (!lead.last_activity_at) return { label: "Stalled", icon: TrendingDown, color: "text-red-600 dark:text-red-400" };
  const daysSinceActivity = differenceInDays(new Date(), parseISO(lead.last_activity_at));
  const hasRecentInbound = lead.last_inbound_at && differenceInDays(new Date(), parseISO(lead.last_inbound_at)) <= 3;
  // Also check WA read receipt as a momentum signal
  const lastReadAt = (lead as any).last_read_at as string | null;
  const hasRecentWaRead = lastReadAt && differenceInDays(new Date(), parseISO(lastReadAt)) <= 1;
  const stage = lead.stage as DealStage;
  if (hasRecentInbound || hasRecentWaRead || (daysSinceActivity <= 2 && (stage === "closing" || stage === "post_meeting"))) {
    return { label: "Rising", icon: TrendingUp, color: "text-emerald-600 dark:text-emerald-400" };
  }
  if (daysSinceActivity <= 5) return { label: "Stable", icon: Minus, color: "text-muted-foreground" };
  return { label: "Stalled", icon: TrendingDown, color: "text-red-600 dark:text-red-400" };
}

/**
 * Returns whether a lead is "warming" on WhatsApp — useful for dashboard callouts.
 * Condition: 3+ WA milestone entries OR a very recent WA read (<2h)
 */
export function isWarmingOnWhatsApp(lead: LeadDetail): boolean {
  const milestones: Milestone[] = lead.milestones_json ? (lead.milestones_json as unknown as Milestone[]) : [];
  const waCount = milestones.filter(m => (m.description || "").toLowerCase().includes("whatsapp")).length;
  if (waCount >= 3) return true;
  const lastReadAt = (lead as any).last_read_at as string | null;
  if (lastReadAt) {
    const hoursAgo = differenceInHours(new Date(), parseISO(lastReadAt));
    if (hoursAgo <= 2) return true;
  }
  return false;
}
