import { differenceInDays, parseISO } from "date-fns";
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

const SIGNAL_PATTERNS = {
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
  const riskPenalty = Math.min(risks.length * 5, 15);
  if (riskPenalty > 0) {
    factors.push({ label: `${risks.length} risk flag${risks.length > 1 ? "s" : ""}`, points: -riskPenalty }); score -= riskPenalty;
  }
  if (stage === "closing") {
    factors.push({ label: "Closing stage", points: 10 }); score += 10;
  }
  return { total: Math.max(0, Math.min(100, score)), factors };
}

export function getMomentum(lead: LeadDetail): { label: string; icon: typeof TrendingUp; color: string } {
  if (!lead.last_activity_at) return { label: "Stalled", icon: TrendingDown, color: "text-red-600 dark:text-red-400" };
  const daysSinceActivity = differenceInDays(new Date(), parseISO(lead.last_activity_at));
  const hasRecentInbound = lead.last_inbound_at && differenceInDays(new Date(), parseISO(lead.last_inbound_at)) <= 3;
  const stage = lead.stage as DealStage;
  if (hasRecentInbound || (daysSinceActivity <= 2 && (stage === "closing" || stage === "post_meeting"))) {
    return { label: "Rising", icon: TrendingUp, color: "text-emerald-600 dark:text-emerald-400" };
  }
  if (daysSinceActivity <= 5) return { label: "Stable", icon: Minus, color: "text-muted-foreground" };
  return { label: "Stalled", icon: TrendingDown, color: "text-red-600 dark:text-red-400" };
}
