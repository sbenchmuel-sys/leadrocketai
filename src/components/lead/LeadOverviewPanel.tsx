import { useEffect, useState } from "react";
import { format, parseISO, differenceInDays } from "date-fns";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Calendar, AlertTriangle, CheckCircle2, ArrowRight,
  Zap, TrendingUp, TrendingDown, ShieldAlert, ChevronDown,
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

  // Auto-collapse logic
  const automationMotionAllowed = motion === "outbound_prospecting" || motion === "nurture";
  const hasAutomation = automationMotionAllowed && stage !== "closed_won" && stage !== "closed_lost";
  const automationPaused = hasAutomation && (!!lead.last_inbound_at || lead.has_future_meeting);

  const isPostMeeting = motion === "post_meeting" || stage === "post_meeting";

  // Section open states
  const [automationOpen, setAutomationOpen] = useState(!automationPaused && hasAutomation);
  const [meetingOpen, setMeetingOpen] = useState(isPostMeeting);
  const [signalsOpen, setSignalsOpen] = useState(false);

  useEffect(() => {
    setAutomationOpen(!automationPaused && hasAutomation);
    setMeetingOpen(isPostMeeting);
  }, [lead.id, automationPaused, hasAutomation, isPostMeeting]);

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

  return (
    <div className="space-y-3 sticky top-4">

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
