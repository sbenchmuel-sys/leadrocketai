import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Mail, Trash2, Zap, Pause, CheckCircle2, TrendingUp, Calendar, PenLine, Plane } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  MOTION_LABELS, MOTION_COLORS,
  SourceType, Motion, getDisplayPhase, DealStage, getOriginCategory,
} from "@/lib/dashboardUtils";
import type { LeadDetail } from "@/lib/supabaseQueries";
import { GmailSyncButton } from "@/components/gmail/GmailSyncButton";
import { EditLeadDialog } from "@/components/lead/EditLeadDialog";
import { useMemo } from "react";
import { calculateClosingPower, getMomentum } from "@/lib/closingPowerUtils";

type OriginContext = "dashboard" | "leads" | "inbox";

interface LeadDetailHeaderProps {
  lead: LeadDetail;
  isConnected: boolean;
  isDeleting: boolean;
  originContext: OriginContext;
  onDelete: () => void;
  onUpdate: () => void;
  onSyncComplete: () => void;
  onCompose?: () => void;
  onAddMeeting?: () => void;
}

function getAutomationLabel(lead: LeadDetail): { label: string; color: string } {
  const stage = lead.stage as DealStage;
  const motion = (lead.motion as Motion) || "outbound_prospecting";

  if (stage === "closed_won" || stage === "closed_lost") {
    return { label: "Completed", color: "text-muted-foreground" };
  }
  // Nurture-specific labels
  if (motion === "nurture") {
    const nurtureStatus = (lead as any).nurture_status || "inactive";
    const nurtureMode = (lead as any).nurture_mode || "review";
    if (nurtureStatus === "paused" || lead.last_inbound_at || lead.has_future_meeting) {
      return { label: "Nurture Paused", color: "text-amber-600 dark:text-amber-400" };
    }
    if (nurtureStatus === "active") {
      return { label: nurtureMode === "automatic" ? "Nurture Auto" : "Nurture Review", color: "text-emerald-600 dark:text-emerald-400" };
    }
    return { label: "Nurture", color: "text-muted-foreground" };
  }

  const automationAllowed = motion === "outbound_prospecting" || motion === "inbound_response";
  if (!automationAllowed) {
    return { label: "Manual", color: "text-muted-foreground" };
  }

  // Check actual automation state from DB fields
  const hasAutomationEnabled = !!(lead as any).eligible_at && lead.needs_action;

  if (!hasAutomationEnabled) {
    // No automation running — check if it's off entirely or just not enabled
    if (lead.next_action_key) {
      return { label: "Paused", color: "text-amber-600 dark:text-amber-400" };
    }
    return { label: "Off", color: "text-muted-foreground" };
  }

  // Automation is enabled — check safety blockers
  if (lead.last_inbound_at) {
    return { label: "Paused", color: "text-amber-600 dark:text-amber-400" };
  }
  if (lead.has_future_meeting) {
    return { label: "Paused", color: "text-amber-600 dark:text-amber-400" };
  }
  return { label: "Active", color: "text-emerald-600 dark:text-emerald-400" };
}

const PHASE_COLORS: Record<string, string> = {
  Prospecting: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200",
  Engaged: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  "Post-Meeting": "bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-200",
  Closing: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
  Nurture: "bg-teal-100 text-teal-800 dark:bg-teal-900/50 dark:text-teal-200",
  Closed: "bg-muted text-muted-foreground",
};

const BACK_ROUTES: Record<OriginContext, string> = {
  dashboard: "/app",
  leads: "/app/leads",
  inbox: "/app/inbox",
};

export default function LeadDetailHeader({
  lead, isConnected, isDeleting, originContext, onDelete, onUpdate, onSyncComplete, onCompose, onAddMeeting,
}: LeadDetailHeaderProps) {
  const navigate = useNavigate();
  const motion = (lead.motion as Motion) || "outbound_prospecting";
  const stage = (lead.stage as DealStage) || "new";
  const phase = getDisplayPhase(stage, motion);
  const origin = getOriginCategory((lead.source_type as SourceType) || "manual_entry");
  const automation = getAutomationLabel(lead);

  const closingPower = useMemo(() => calculateClosingPower(lead), [lead]);
  const momentum = useMemo(() => getMomentum(lead), [lead]);
  const MomentumIcon = momentum.icon;

  const originLabel = origin === "inbound" ? "Inbound" : "Outbound";

  return (
    <div className="space-y-0">
      {/* Back + Actions row — slim */}
      <div className="flex items-center justify-between pb-2">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(BACK_ROUTES[originContext])}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex gap-1.5">
          <EditLeadDialog lead={lead} onUpdate={onUpdate} />
          {isConnected ? (
            <GmailSyncButton leadId={lead.id} leadEmail={lead.email} onSyncComplete={onSyncComplete} />
          ) : (
            <Button variant="outline" size="sm" className="h-8 text-xs" asChild>
              <Link to="/app/settings"><Mail className="h-3.5 w-3.5 mr-1.5" />Connect Gmail</Link>
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 w-8 p-0 text-destructive hover:text-destructive">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Lead</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete <strong>{lead.name}</strong> from <strong>{lead.company}</strong>? This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={onDelete} disabled={isDeleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                  {isDeleting ? "Deleting..." : "Delete Lead"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* ROW 1 — Identity + Status Strip + Closing Power */}
      <div className="flex items-center gap-6 py-3">
        {/* LEFT — Identity */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg font-bold text-foreground leading-tight truncate">{lead.name}</h1>
            {(lead as any).ooo_until && new Date((lead as any).ooo_until) > new Date() && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border border-amber-200 dark:border-amber-800/50 shrink-0">
                <Plane className="h-2.5 w-2.5" />
                OOO until {new Date((lead as any).ooo_until).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground leading-snug truncate">
            {lead.job_title ? `${lead.job_title} · ` : ""}{lead.company}{lead.country ? ` · ${lead.country}` : ""}
          </p>
          <p className="text-xs text-muted-foreground/70 mt-0.5 truncate">{lead.email}</p>
        </div>

        {/* CENTER — Unified Status Strip */}
        <div className="hidden md:flex items-center gap-2 text-xs text-muted-foreground flex-shrink-0">
          {/* Phase pill — gets color */}
          <span className={cn(
            "px-2.5 py-1 rounded-full font-medium text-[11px]",
            PHASE_COLORS[phase] || "bg-muted text-muted-foreground",
          )}>
            {phase}
          </span>
          <span className="text-border">·</span>
          <span>{originLabel}</span>
          <span className="text-border">·</span>
          <span className={cn("font-medium", automation.color)}>
            Automation {automation.label}
          </span>
        </div>

        {/* RIGHT — Closing Power */}
        <div className="flex-shrink-0 text-right">
          <div className="flex items-end gap-2 justify-end">
            <div>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground block leading-none mb-1">Closing Power</span>
              <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-all duration-500",
                    closingPower.total >= 60 ? "bg-emerald-500" : closingPower.total >= 30 ? "bg-amber-500" : "bg-red-500"
                  )}
                  style={{ width: `${closingPower.total}%` }}
                />
              </div>
            </div>
            <span className={cn("text-2xl font-bold tabular-nums leading-none",
              closingPower.total >= 60 ? "text-emerald-600 dark:text-emerald-400" : closingPower.total >= 30 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400"
            )}>
              {closingPower.total}
            </span>
          </div>
          <div className={cn("flex items-center gap-1 justify-end mt-1 text-[11px]", momentum.color)}>
            <MomentumIcon className="h-3 w-3" />
            <span>{momentum.label}</span>
          </div>
        </div>
      </div>

      {/* Mobile status strip (visible only on small screens) */}
      <div className="flex md:hidden items-center gap-1.5 text-[11px] text-muted-foreground pb-2 flex-wrap">
        <span className={cn(
          "px-2 py-0.5 rounded-full font-medium",
          PHASE_COLORS[phase] || "bg-muted text-muted-foreground",
        )}>
          {phase}
        </span>
        <span className="text-border">·</span>
        <span className={cn("font-medium", automation.color)}>
          {automation.label}
        </span>
      </div>

      {/* ROW 2 — Recommended Action Strip */}
      {lead.next_step && (
        <>
          <div className="border-t border-border/40" />
          <div className="flex items-center gap-3 py-2.5">
            <div className="flex-1 min-w-0">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-2">Recommended</span>
              <span className="text-sm font-medium text-foreground">{lead.next_step}</span>
            </div>
            <div className="flex gap-1.5 flex-shrink-0">
              {onCompose && (
                <Button size="sm" className="h-7 text-xs px-3" onClick={onCompose}>
                  <PenLine className="h-3 w-3 mr-1" />
                  Compose
                </Button>
              )}
              {onAddMeeting && (
                <Button variant="outline" size="sm" className="h-7 text-xs px-3" onClick={onAddMeeting}>
                  <Calendar className="h-3 w-3 mr-1" />
                  Add Meeting
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
