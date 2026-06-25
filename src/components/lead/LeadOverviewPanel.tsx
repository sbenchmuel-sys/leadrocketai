import { useCallback, useEffect, useState } from "react";
import { format, parseISO, differenceInDays } from "date-fns";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Calendar, AlertTriangle, CheckCircle2, ArrowRight,
  ChevronDown, Mail,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Motion, DealStage,
} from "@/lib/dashboardUtils";
import { getLeadMeetingPacks, MeetingPackItem } from "@/lib/supabaseQueries";
import type { LeadDetail } from "@/lib/supabaseQueries";
import { getLeadActivityFeed } from "@/lib/leadActivity";
import AutomationToggleCard from "@/components/lead/AutomationToggleCard";
import NurturePreviewCard from "@/components/lead/NurturePreviewCard";
import LogMeetingDialog from "@/components/lead/LogMeetingDialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

interface LeadOverviewPanelProps {
  lead: LeadDetail;
  onNavigateToMeetings: () => void;
  onUpdate?: () => void;
}

export default function LeadOverviewPanel({ lead, onNavigateToMeetings, onUpdate }: LeadOverviewPanelProps) {
  const [lastMeeting, setLastMeeting] = useState<MeetingPackItem | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [recapAlreadySent, setRecapAlreadySent] = useState(false);
  const [recapSentDate, setRecapSentDate] = useState<string | null>(null);
  const [showLogDialog, setShowLogDialog] = useState(false);

  const motion = (lead.motion as Motion) || "outbound_prospecting";
  const stage = (lead.stage as DealStage) || "new";

  // Auto-collapse logic
  const isNurtureMotion = motion === "nurture";
  const automationMotionAllowed = motion === "outbound_prospecting" || motion === "inbound_response";
  const hasAutomation = automationMotionAllowed && stage !== "closed_won" && stage !== "closed_lost";
  const automationActive = hasAutomation && !!(lead as any).eligible_at && lead.needs_action && !lead.last_inbound_at && !lead.has_future_meeting;
  const automationPaused = hasAutomation && !automationActive;
  const hasNurture = isNurtureMotion && ((lead as any).nurture_status === "active" || (lead as any).nurture_status === "paused");

  const isPostMeeting = motion === "post_meeting" || stage === "post_meeting";

  // Section open states
  const [automationOpen, setAutomationOpen] = useState(!automationPaused && hasAutomation);
  const [meetingOpen, setMeetingOpen] = useState(isPostMeeting);

  useEffect(() => {
    setAutomationOpen(!automationPaused && hasAutomation);
    setMeetingOpen(isPostMeeting);
  }, [lead.id, automationPaused, hasAutomation, isPostMeeting]);

  const loadMeeting = useCallback(async () => {
    try {
      // Reset recap-sent state each load so a freshly-logged meeting isn't shown
      // as already-followed-up from a previous meeting's state.
      setRecapAlreadySent(false);
      setRecapSentDate(null);
      const [packs, activity] = await Promise.all([
        getLeadMeetingPacks(lead.id),
        getLeadActivityFeed(lead.id, { limit: 50 }),
      ]);
      if (packs.length > 0) {
        setLastMeeting(packs[0]);
        const meetingDate = new Date(packs[0].meeting_date || packs[0].created_at);
        const outboundAfter = activity.find(
          (a) =>
            a.channel === "email" &&
            a.direction === "outbound" &&
            new Date(a.occurred_at) > meetingDate
        );
        if (outboundAfter) {
          setRecapAlreadySent(true);
          setRecapSentDate(outboundAfter.occurred_at);
        }
      } else {
        setLastMeeting(null);
      }
    } catch (err) {
      console.error("Failed to load meeting packs:", err);
    } finally {
      setIsLoading(false);
    }
  }, [lead.id]);

  useEffect(() => {
    loadMeeting();
  }, [loadMeeting]);

  return (
    <div className="space-y-3 sticky top-4">

      {/* NURTURE — shown for nurture motion leads */}
      {hasNurture && (
        <>
          <NurturePreviewCard lead={lead} onUpdate={onUpdate || (() => {})} />
          <Separator className="bg-border/40" />
        </>
      )}

      {/* AUTOMATION — slim on/off toggle (Unit 3). Full controls live behind its
          "Details" disclosure. Returns null when automation isn't eligible. */}
      {hasAutomation && !isNurtureMotion && (
        <AutomationToggleCard lead={lead} onUpdate={onUpdate || (() => {})} />
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
                {(() => {
                  // Show the date once. Auto-titled packs are "Meeting — <date>",
                  // so a title that already contains the formatted date would read
                  // "Jun 17, 2026 — Meeting — Jun 17, 2026" — drop the redundant title.
                  const dateStr = lastMeeting.meeting_date
                    ? format(parseISO(lastMeeting.meeting_date), "MMM d, yyyy")
                    : format(parseISO(lastMeeting.created_at), "MMM d, yyyy");
                  const title = lastMeeting.title?.trim() || "";
                  const showTitle = title && !title.includes(dateStr);
                  return (
                    <div className="flex items-center gap-1.5 text-sm">
                      <span className="font-medium">{dateStr}</span>
                      {showTitle && (
                        <span className="text-muted-foreground text-xs truncate">— {title}</span>
                      )}
                    </div>
                  );
                })()}
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
                <Button variant="outline" size="sm" onClick={() => setShowLogDialog(true)} className="w-full text-xs h-7">
                  <Calendar className="h-3 w-3 mr-1" /> Log a meeting
                </Button>
                <Button variant="ghost" size="sm" onClick={onNavigateToMeetings} className="w-full text-primary text-xs h-7">
                  See all meetings <ArrowRight className="h-3 w-3 ml-1" />
                </Button>
              </div>
            </CollapsibleContent>
          </Collapsible>
          <Separator className="bg-border/40" />
        </>
      )}

      {/* NO MEETING YET — keep a quiet way to log the first one (the card above is
          hidden until there's a meeting, so without this a new lead has nowhere to log). */}
      {!isLoading && !lastMeeting && (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowLogDialog(true)}
            className="w-full justify-start px-0 text-muted-foreground hover:text-foreground text-xs h-7"
          >
            <Calendar className="h-3 w-3 mr-1.5 text-primary" /> Log a meeting
          </Button>
          <Separator className="bg-border/40" />
        </>
      )}

      <LogMeetingDialog
        open={showLogDialog}
        onOpenChange={setShowLogDialog}
        leadId={lead.id}
        onSaved={() => { loadMeeting(); onUpdate?.(); }}
      />
      {/* Signals & Risks intentionally dropped here in Unit 3 — the canonical
          Risks / Buying Signals live in the Intelligence card above the tabs,
          so the rail stays to Automation + Latest Meeting only. */}
    </div>
  );
}
