import { useEffect, useState, useMemo } from "react";
import { format, parseISO, differenceInDays } from "date-fns";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Calendar, Target, AlertTriangle, CheckCircle2, ArrowRight,
  Zap, TrendingUp, TrendingDown, Minus, ShieldAlert, ChevronDown,
  Pause, Mail,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Motion, DealStage, getDisplayPhase,
} from "@/lib/dashboardUtils";
import { getLeadMeetingPacks, getLeadInteractions, MeetingPackItem } from "@/lib/supabaseQueries";
import type { LeadDetail } from "@/lib/supabaseQueries";
import AutomationPreviewCard from "@/components/lead/AutomationPreviewCard";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

interface LeadOverviewPanelProps {
  lead: LeadDetail;
  onNavigateToMeetings: () => void;
  onUpdate?: () => void;
}

interface Milestone {
  description: string;
  status: "completed" | "pending";
  date: string | null;
}

interface Risk {
  issue: string;
  level: "low" | "medium" | "high";
}

// Known buying signal keywords from milestones
const BUYING_SIGNAL_KEYWORDS = [
  { match: /pric/i, label: "Pricing mentioned" },
  { match: /decision.?maker|dm\b|c-level|ceo|cfo|cto|vp\b/i, label: "Decision maker involved" },
  { match: /proposal|contract|agreement|sow\b|scope/i, label: "Requested docs / proposal" },
  { match: /budget|funding|allocated/i, label: "Budget discussed" },
  { match: /timeline|deadline|launch|go.?live/i, label: "Timeline defined" },
  { match: /champion|advocate|sponsor/i, label: "Internal champion identified" },
  { match: /poc|proof.?of.?concept|pilot|trial/i, label: "POC / trial requested" },
];

// Closing Power Score
const SIGNAL_PATTERNS = {
  pricing: /pric|cost|quote|proposal/i,
  decision_maker: /decision.?maker|dm\b|c-level|ceo|cfo|cto|vp\b|director/i,
  docs_requested: /proposal|contract|agreement|sow\b|scope|nda/i,
};

interface ScoreBreakdown {
  total: number;
  factors: { label: string; points: number }[];
}

function calculateClosingPower(lead: LeadDetail): ScoreBreakdown {
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

function getMomentum(lead: LeadDetail): { label: string; icon: typeof TrendingUp; color: string } {
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

function detectBuyingSignals(milestones: Milestone[]): string[] {
  const signals: string[] = [];
  const allText = milestones.map(m => m.description).join(" ");
  for (const kw of BUYING_SIGNAL_KEYWORDS) {
    if (kw.match.test(allText)) signals.push(kw.label);
  }
  return signals;
}

export default function LeadOverviewPanel({ lead, onNavigateToMeetings, onUpdate }: LeadOverviewPanelProps) {
  const [lastMeeting, setLastMeeting] = useState<MeetingPackItem | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [recapAlreadySent, setRecapAlreadySent] = useState(false);
  const [recapSentDate, setRecapSentDate] = useState<string | null>(null);

  const motion = (lead.motion as Motion) || "outbound_prospecting";
  const stage = (lead.stage as DealStage) || "new";

  const milestones: Milestone[] = lead.milestones_json ? (lead.milestones_json as unknown as Milestone[]) : [];
  const risks: Risk[] = lead.risks_json ? (lead.risks_json as unknown as Risk[]) : [];
  const buyingSignals = detectBuyingSignals(milestones);
  const signalCount = buyingSignals.length + risks.length;

  const closingPower = useMemo(() => calculateClosingPower(lead), [lead]);
  const momentum = useMemo(() => getMomentum(lead), [lead]);
  const MomentumIcon = momentum.icon;

  // Auto-collapse logic
  const automationMotionAllowed = motion === "outbound_prospecting" || motion === "nurture";
  const hasAutomation = automationMotionAllowed && stage !== "closed_won" && stage !== "closed_lost";
  const automationPaused = hasAutomation && (!!lead.last_inbound_at || lead.has_future_meeting);

  const needsAction = lead.needs_action && !!lead.next_step;
  const isPostMeeting = motion === "post_meeting" || stage === "post_meeting";

  // Section open states
  const [automationOpen, setAutomationOpen] = useState(!automationPaused && hasAutomation);
  const [actionOpen, setActionOpen] = useState(!!needsAction);
  const [meetingOpen, setMeetingOpen] = useState(isPostMeeting);
  const [signalsOpen, setSignalsOpen] = useState(false);

  useEffect(() => {
    setAutomationOpen(!automationPaused && hasAutomation);
    setActionOpen(!!needsAction);
    setMeetingOpen(isPostMeeting);
  }, [lead.id, automationPaused, hasAutomation, needsAction, isPostMeeting]);

  useEffect(() => {
    const load = async () => {
      try {
        const [packs, interactions] = await Promise.all([
          getLeadMeetingPacks(lead.id),
          getLeadInteractions(lead.id),
        ]);
        if (packs.length > 0) {
          setLastMeeting(packs[0]);
          const meetingDate = new Date(packs[0].meeting_date || packs[0].created_at);
          const outboundAfter = interactions.find(
            (i) => i.type === "email_outbound" && new Date(i.occurred_at) > meetingDate
          );
          if (outboundAfter) {
            setRecapAlreadySent(true);
            setRecapSentDate(outboundAfter.occurred_at);
          }
        }
      } catch (err) {
        console.error("Failed to load meeting packs:", err);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [lead.id]);

  // Determine section order based on priority
  const showAction = needsAction && lead.next_step && !(recapAlreadySent && /recap|post.?meeting/i.test(lead.next_step || ""));

  return (
    <div className="space-y-3 sticky top-4">
      {/* 1. CLOSING POWER — Always Expanded */}
      <div className="space-y-2 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Closing Power</span>
          <div className={cn("flex items-center gap-1.5 text-sm font-medium", momentum.color)}>
            <MomentumIcon className="h-3.5 w-3.5" />
            <span className="text-xs">{momentum.label}</span>
          </div>
        </div>
        {/* Score bar */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all duration-500",
                closingPower.total >= 60 ? "bg-emerald-500" : closingPower.total >= 30 ? "bg-amber-500" : "bg-red-500"
              )}
              style={{ width: `${closingPower.total}%` }}
            />
          </div>
          <span className={cn("text-2xl font-bold tabular-nums leading-none",
            closingPower.total >= 60 ? "text-emerald-600 dark:text-emerald-400" : closingPower.total >= 30 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400"
          )}>
            {closingPower.total}
          </span>
        </div>
        {/* Micro-text score breakdown */}
        <div className="space-y-0.5">
          {closingPower.factors.map((f, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className={cn("font-medium tabular-nums",
                f.points > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
              )}>
                {f.points > 0 ? "+" : ""}{f.points}
              </span>
              <span>{f.label}</span>
            </div>
          ))}
        </div>
      </div>

      <Separator className="bg-border/40" />

      {/* 2/3. RECOMMENDED ACTION — auto-promotes above automation when needs_action */}
      {showAction && (
        <>
          <Collapsible open={actionOpen} onOpenChange={setActionOpen}>
            <CollapsibleTrigger className="flex items-center justify-between w-full py-2 group">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5">
                <Zap className="h-3 w-3 text-primary" /> Recommended Action
              </span>
              <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", actionOpen && "rotate-180")} />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pb-3">
                <p className="text-sm font-medium text-foreground leading-snug">{lead.next_step}</p>
                {lead.next_step_reason && (
                  <p className="text-xs text-muted-foreground mt-1">{lead.next_step_reason}</p>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
          <Separator className="bg-border/40" />
        </>
      )}

      {/* AUTOMATION — expanded if active, collapsed if paused, hidden if N/A */}
      {hasAutomation && (
        <>
          <Collapsible open={automationOpen} onOpenChange={setAutomationOpen}>
            <CollapsibleTrigger className="flex items-center justify-between w-full py-2 group">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5">
                {automationPaused ? (
                  <><Pause className="h-3 w-3 text-amber-500" /> Automation Paused</>
                ) : (
                  <><Zap className="h-3 w-3 text-emerald-500" /> Automation Active</>
                )}
              </span>
              <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", automationOpen && "rotate-180")} />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pb-2">
                <AutomationPreviewCard lead={lead} onUpdate={onUpdate || (() => {})} />
              </div>
            </CollapsibleContent>
          </Collapsible>
          <Separator className="bg-border/40" />
        </>
      )}

      {/* LATEST MEETING — expanded if post_meeting, collapsed if old, hidden if none */}
      {!isLoading && lastMeeting && (
        <>
          <Collapsible open={meetingOpen} onOpenChange={setMeetingOpen}>
            <CollapsibleTrigger className="flex items-center justify-between w-full py-2 group">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5">
                <Calendar className="h-3 w-3 text-primary" /> Latest Meeting
              </span>
              <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", meetingOpen && "rotate-180")} />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pb-3 space-y-2">
                <div className="flex items-center gap-1.5 text-sm">
                  <span className="font-medium">
                    {lastMeeting.meeting_date
                      ? format(parseISO(lastMeeting.meeting_date), "MMM d, yyyy")
                      : format(parseISO(lastMeeting.created_at), "MMM d, yyyy")}
                  </span>
                  {lastMeeting.title && (
                    <span className="text-muted-foreground text-xs truncate">— {lastMeeting.title}</span>
                  )}
                </div>
                {lastMeeting.internal_recap_bullets.length > 0 && (
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {lastMeeting.internal_recap_bullets.slice(0, 3).map((b, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="text-primary mt-0.5">•</span>
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {lastMeeting.milestones.length > 0 && (
                  <div className="space-y-1">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Milestones</span>
                    {lastMeeting.milestones.slice(0, 3).map((m, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-xs">
                        <CheckCircle2 className={cn("h-3 w-3", m.status === "completed" ? "text-emerald-500" : "text-muted-foreground")} />
                        <span className={m.status === "completed" ? "line-through text-muted-foreground" : "text-foreground"}>{m.description}</span>
                      </div>
                    ))}
                  </div>
                )}
                {lastMeeting.open_questions.length > 0 && (
                  <div className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{lastMeeting.open_questions.length}</span> open question{lastMeeting.open_questions.length !== 1 ? "s" : ""}
                  </div>
                )}
                {recapAlreadySent ? (
                  <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 rounded-md px-2 py-1.5">
                    <Mail className="h-3 w-3" />
                    <span className="font-medium">Post-meeting email sent</span>
                    {recapSentDate && (
                      <span className="text-muted-foreground ml-auto">
                        {format(parseISO(recapSentDate), "MMM d")}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded-md px-2 py-1.5">
                    <AlertTriangle className="h-3 w-3" />
                    <span className="font-medium">Post-meeting recap pending</span>
                  </div>
                )}
                <Button variant="ghost" size="sm" onClick={onNavigateToMeetings} className="w-full text-primary text-xs h-7">
                  View all meetings <ArrowRight className="h-3 w-3 ml-1" />
                </Button>
              </div>
            </CollapsibleContent>
          </Collapsible>
          <Separator className="bg-border/40" />
        </>
      )}

      {/* SIGNALS & RISKS — Always collapsed */}
      {(buyingSignals.length > 0 || risks.length > 0) && (
        <Collapsible open={signalsOpen} onOpenChange={setSignalsOpen}>
          <CollapsibleTrigger className="flex items-center justify-between w-full py-2 group">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5">
              <ShieldAlert className="h-3 w-3" /> Signals & Risks
              {signalCount > 0 && (
                <span className="text-[9px] bg-muted rounded-full px-1.5 py-0.5 tabular-nums">{signalCount}</span>
              )}
            </span>
            <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", signalsOpen && "rotate-180")} />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="pb-3 space-y-3">
              {buyingSignals.length > 0 && (
                <div className="space-y-1">
                  <span className="text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                    <TrendingUp className="h-3 w-3" /> Buying Signals
                  </span>
                  {buyingSignals.map((s, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-xs text-foreground">
                      <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                      {s}
                    </div>
                  ))}
                </div>
              )}
              {buyingSignals.length > 0 && risks.length > 0 && <Separator className="bg-border/40" />}
              {risks.length > 0 && (
                <div className="space-y-1">
                  <span className="text-[10px] uppercase tracking-wider text-red-600 dark:text-red-400 font-medium flex items-center gap-1">
                    <ShieldAlert className="h-3 w-3" /> Risks
                  </span>
                  {risks.slice(0, 5).map((r, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-xs">
                      <AlertTriangle className={cn("h-3 w-3",
                        r.level === "high" ? "text-red-500" : r.level === "medium" ? "text-amber-500" : "text-muted-foreground"
                      )} />
                      <span className="text-foreground">{r.issue}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
