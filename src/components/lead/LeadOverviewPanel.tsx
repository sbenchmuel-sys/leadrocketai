import { useEffect, useState } from "react";
import { format, parseISO } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Calendar, Target, AlertTriangle, CheckCircle2, ArrowRight,
  Zap, TrendingUp, ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  SOURCE_TYPE_LABELS, SOURCE_TYPE_COLORS, MOTION_LABELS, MOTION_ICONS, MOTION_COLORS,
  SourceType, Motion, getDisplayPhase, DealStage,
} from "@/lib/dashboardUtils";
import { getLeadMeetingPacks, MeetingPackItem } from "@/lib/supabaseQueries";
import type { LeadDetail } from "@/lib/supabaseQueries";

interface LeadOverviewPanelProps {
  lead: LeadDetail;
  onNavigateToMeetings: () => void;
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
    if (kw.match.test(allText)) {
      signals.push(kw.label);
    }
  }
  return signals;
}

export default function LeadOverviewPanel({ lead, onNavigateToMeetings }: LeadOverviewPanelProps) {
  const [lastMeeting, setLastMeeting] = useState<MeetingPackItem | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const sourceType = (lead.source_type as SourceType) || "manual_entry";
  const motion = (lead.motion as Motion) || "outbound_prospecting";
  const stage = (lead.stage as DealStage) || "new";
  const phase = getDisplayPhase(stage, motion);

  const milestones: Milestone[] = lead.milestones_json ? (lead.milestones_json as unknown as Milestone[]) : [];
  const risks: Risk[] = lead.risks_json ? (lead.risks_json as unknown as Risk[]) : [];
  const buyingSignals = detectBuyingSignals(milestones);

  useEffect(() => {
    const load = async () => {
      try {
        const packs = await getLeadMeetingPacks(lead.id);
        if (packs.length > 0) setLastMeeting(packs[0]);
      } catch (err) {
        console.error("Failed to load meeting packs:", err);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [lead.id]);

  return (
    <div className="space-y-4 sticky top-4">
      {/* A) Lead Overview */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Overview</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Phase</span>
              <span className="font-semibold">{phase}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Source</span>
              <span className={cn(
                "text-xs px-2 py-0.5 rounded-full inline-flex items-center gap-1",
                SOURCE_TYPE_COLORS[sourceType]?.bg, SOURCE_TYPE_COLORS[sourceType]?.text,
              )}>
                <span className={cn("w-1.5 h-1.5 rounded-full", SOURCE_TYPE_COLORS[sourceType]?.dot)} />
                {SOURCE_TYPE_LABELS[sourceType]}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Motion</span>
              <span className={cn(
                "text-xs px-2 py-0.5 rounded-md inline-flex items-center gap-1",
                MOTION_COLORS[motion]?.bg, MOTION_COLORS[motion]?.text,
              )}>
                {MOTION_ICONS[motion]} {MOTION_LABELS[motion]}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Strategy</span>
              <Badge variant="outline" className="text-xs">
                {lead.strategy === "fast" ? "⚡ Fast" : "🌱 Nurture"}
              </Badge>
            </div>
            {lead.next_action_label && (
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Next Action</span>
                <span className="text-xs font-medium text-foreground">{lead.next_action_label}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* B) Most Recent Meeting Recap */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Latest Meeting</h3>
          {isLoading ? (
            <div className="h-12 flex items-center justify-center">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary" />
            </div>
          ) : lastMeeting ? (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-sm">
                <Calendar className="h-3.5 w-3.5 text-primary" />
                <span className="font-medium">
                  {lastMeeting.meeting_date
                    ? format(parseISO(lastMeeting.meeting_date), "MMM d, yyyy")
                    : format(parseISO(lastMeeting.created_at), "MMM d, yyyy")}
                </span>
                {lastMeeting.title && (
                  <span className="text-muted-foreground text-xs truncate">— {lastMeeting.title}</span>
                )}
              </div>
              {/* 3 bullet summary */}
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
              {/* Milestones from meeting */}
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
              {/* Open questions */}
              {lastMeeting.open_questions.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{lastMeeting.open_questions.length}</span> open question{lastMeeting.open_questions.length !== 1 ? "s" : ""}
                </div>
              )}
              <Button variant="ghost" size="sm" onClick={onNavigateToMeetings} className="w-full text-primary text-xs h-7">
                View all meetings <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No meetings yet</p>
          )}
        </CardContent>
      </Card>

      {/* C) Buying Signals & Risks */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Signals & Risks</h3>
          {/* Buying Signals */}
          <div className="space-y-1.5">
            <span className="text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> Buying Signals
            </span>
            {buyingSignals.length > 0 ? (
              buyingSignals.map((s, i) => (
                <div key={i} className="flex items-center gap-1.5 text-xs text-foreground">
                  <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                  {s}
                </div>
              ))
            ) : (
              <p className="text-xs text-muted-foreground">None detected yet</p>
            )}
          </div>
          <Separator />
          {/* Risks */}
          <div className="space-y-1.5">
            <span className="text-[10px] uppercase tracking-wider text-red-600 dark:text-red-400 font-medium flex items-center gap-1">
              <ShieldAlert className="h-3 w-3" /> Risks
            </span>
            {risks.length > 0 ? (
              risks.slice(0, 5).map((r, i) => (
                <div key={i} className="flex items-center gap-1.5 text-xs">
                  <AlertTriangle className={cn("h-3 w-3",
                    r.level === "high" ? "text-red-500" : r.level === "medium" ? "text-amber-500" : "text-muted-foreground"
                  )} />
                  <span className="text-foreground">{r.issue}</span>
                </div>
              ))
            ) : (
              <p className="text-xs text-muted-foreground">No risks identified</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* D) Recommended Next Action */}
      {lead.next_step && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="pt-4 space-y-1">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <Zap className="h-3 w-3 text-primary" /> Recommended
            </h3>
            <p className="text-sm font-medium text-foreground">{lead.next_step}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
