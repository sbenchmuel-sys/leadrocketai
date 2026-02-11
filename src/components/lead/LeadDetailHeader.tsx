import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Mail, Briefcase, Phone, Building2, Globe, MessageSquare, Trash2, Zap, Pause, CheckCircle2, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  SOURCE_TYPE_LABELS, SOURCE_TYPE_COLORS, MOTION_LABELS, MOTION_ICONS, MOTION_COLORS,
  SourceType, Motion, getDisplayPhase, DealStage, getOriginCategory,
} from "@/lib/dashboardUtils";
import type { LeadDetail } from "@/lib/supabaseQueries";
import { GmailSyncButton } from "@/components/gmail/GmailSyncButton";
import { EditLeadDialog } from "@/components/lead/EditLeadDialog";
import { differenceInDays, parseISO } from "date-fns";

interface LeadDetailHeaderProps {
  lead: LeadDetail;
  isConnected: boolean;
  isDeleting: boolean;
  onDelete: () => void;
  onUpdate: () => void;
  onSyncComplete: () => void;
}

// Derive automation status from lead fields
function getAutomationStatus(lead: LeadDetail): { label: string; color: string; icon: typeof Zap } {
  const stage = lead.stage as DealStage;
  if (stage === "closed_won" || stage === "closed_lost") {
    return { label: "Completed", color: "text-muted-foreground bg-muted", icon: CheckCircle2 };
  }
  if (lead.last_inbound_at && lead.last_outbound_at) {
    const inbound = new Date(lead.last_inbound_at).getTime();
    const outbound = new Date(lead.last_outbound_at).getTime();
    if (inbound > outbound) {
      return { label: "Paused – Reply Detected", color: "text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40", icon: Pause };
    }
  }
  if (lead.has_future_meeting) {
    return { label: "Paused – Meeting Scheduled", color: "text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40", icon: Pause };
  }
  return { label: "Active", color: "text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40", icon: Zap };
}

// Simple momentum derivation
function getMomentum(lead: LeadDetail): { label: string; icon: typeof TrendingUp; color: string } {
  if (!lead.last_activity_at) return { label: "Stalled", icon: TrendingDown, color: "text-red-600 dark:text-red-400" };
  const daysSince = differenceInDays(new Date(), parseISO(lead.last_activity_at));
  if (daysSince <= 3) return { label: "Rising", icon: TrendingUp, color: "text-emerald-600 dark:text-emerald-400" };
  if (daysSince <= 10) return { label: "Stable", icon: Minus, color: "text-muted-foreground" };
  return { label: "Stalled", icon: TrendingDown, color: "text-red-600 dark:text-red-400" };
}

// Simple closing power score (0-100)
function getClosingPower(lead: LeadDetail): number {
  let score = 20; // base
  const stage = lead.stage as DealStage;
  if (stage === "closing") score += 30;
  else if (stage === "post_meeting") score += 20;
  else if (stage === "engaged") score += 10;
  if (lead.deal_outlook === "positive") score += 20;
  else if (lead.deal_outlook === "negative") score -= 10;
  if (lead.last_inbound_at) score += 10;
  if (lead.has_future_meeting) score += 10;
  if (lead.last_activity_at) {
    const days = differenceInDays(new Date(), parseISO(lead.last_activity_at));
    if (days <= 2) score += 10;
    else if (days > 14) score -= 15;
  }
  return Math.max(0, Math.min(100, score));
}

export default function LeadDetailHeader({ lead, isConnected, isDeleting, onDelete, onUpdate, onSyncComplete }: LeadDetailHeaderProps) {
  const sourceType = (lead.source_type as SourceType) || "manual_entry";
  const motion = (lead.motion as Motion) || "outbound_prospecting";
  const stage = (lead.stage as DealStage) || "new";
  const phase = getDisplayPhase(stage, motion);
  const origin = getOriginCategory(sourceType);
  const automation = getAutomationStatus(lead);
  const momentum = getMomentum(lead);
  const closingPower = getClosingPower(lead);
  const AutoIcon = automation.icon;
  const MomentumIcon = momentum.icon;

  return (
    <div className="space-y-4">
      {/* Back + Actions row */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard/leads"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div className="flex gap-2">
          <EditLeadDialog lead={lead} onUpdate={onUpdate} />
          {isConnected ? (
            <GmailSyncButton leadId={lead.id} leadEmail={lead.email} onSyncComplete={onSyncComplete} />
          ) : (
            <Button variant="outline" size="sm" asChild>
              <Link to="/dashboard/settings"><Mail className="h-4 w-4 mr-2" />Connect Gmail</Link>
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="text-destructive hover:text-destructive">
                <Trash2 className="h-4 w-4" />
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

      {/* Main 3-column card */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 rounded-lg border bg-card">
        {/* LEFT — Identity */}
        <div className="space-y-2">
          <h1 className="text-xl font-bold text-foreground">{lead.name}</h1>
          <p className="text-sm text-muted-foreground">{lead.company}</p>
          {lead.job_title && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Briefcase className="h-3 w-3" /> {lead.job_title}
            </span>
          )}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {/* Source badge */}
            <span className={cn(
              "text-xs px-2 py-0.5 rounded-full inline-flex items-center gap-1.5",
              SOURCE_TYPE_COLORS[sourceType]?.bg,
              SOURCE_TYPE_COLORS[sourceType]?.text,
            )}>
              <span className={cn("w-1.5 h-1.5 rounded-full", SOURCE_TYPE_COLORS[sourceType]?.dot)} />
              {SOURCE_TYPE_LABELS[sourceType]}
            </span>
            {/* Strategy badge */}
            <Badge variant="outline" className="text-xs">
              {lead.strategy === "fast" ? "⚡ Fast" : "🌱 Nurture"}
            </Badge>
          </div>
          {/* Contact details */}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground pt-1">
            <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{lead.email}</span>
            {lead.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{lead.phone}</span>}
            {lead.industry && <span className="flex items-center gap-1"><Building2 className="h-3 w-3" />{lead.industry}</span>}
            {lead.country && <span className="flex items-center gap-1"><Globe className="h-3 w-3" />{lead.country}</span>}
          </div>
        </div>

        {/* CENTER — State */}
        <div className="flex flex-col items-center justify-center space-y-3 border-x border-border px-4">
          {/* Phase — large */}
          <div className="text-center">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Phase</span>
            <div className="text-lg font-bold text-foreground">{phase}</div>
          </div>
          {/* Motion badge */}
          <span className={cn(
            "text-xs px-2.5 py-1 rounded-md inline-flex items-center gap-1.5 font-medium",
            MOTION_COLORS[motion]?.bg, MOTION_COLORS[motion]?.text,
          )}>
            <span>{MOTION_ICONS[motion]}</span>
            {MOTION_LABELS[motion]}
          </span>
          {/* Cadence step */}
          {lead.next_action_label && (
            <div className="text-center">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Next Step</span>
              <p className="text-xs font-medium text-foreground">{lead.next_action_label}</p>
            </div>
          )}
          {/* Needs action */}
          <Badge variant={lead.needs_action ? "default" : "secondary"} className="text-xs">
            {lead.needs_action ? "⚡ Action Required" : "No Action"}
          </Badge>
          {/* Internal stage */}
          <span className="text-[10px] text-muted-foreground">stage: {stage}</span>
        </div>

        {/* RIGHT — Metrics */}
        <div className="flex flex-col items-end justify-center space-y-3">
          {/* Closing Power Score */}
          <div className="text-right">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Closing Power</span>
            <div className="flex items-baseline gap-1 justify-end">
              <span className={cn("text-2xl font-bold", closingPower >= 60 ? "text-emerald-600 dark:text-emerald-400" : closingPower >= 30 ? "text-amber-600 dark:text-amber-400" : "text-red-600 dark:text-red-400")}>
                {closingPower}
              </span>
              <span className="text-xs text-muted-foreground">/100</span>
            </div>
          </div>
          {/* Momentum */}
          <div className="text-right">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Momentum</span>
            <div className={cn("flex items-center gap-1 justify-end text-sm font-medium", momentum.color)}>
              <MomentumIcon className="h-3.5 w-3.5" />
              {momentum.label}
            </div>
          </div>
          {/* Automation status */}
          <div className="text-right">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Automation</span>
            <span className={cn("text-xs px-2 py-0.5 rounded-full inline-flex items-center gap-1 font-medium mt-0.5", automation.color)}>
              <AutoIcon className="h-3 w-3" />
              {automation.label}
            </span>
          </div>
          {/* Deal outlook */}
          {lead.deal_outlook && (
            <Badge className={cn("text-xs",
              lead.deal_outlook === "positive" ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" :
              lead.deal_outlook === "negative" ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" :
              "bg-secondary text-secondary-foreground"
            )}>
              {lead.deal_outlook}
            </Badge>
          )}
        </div>
      </div>

      {/* Initial message */}
      {lead.initial_message && (
        <div className="p-3 bg-muted/50 rounded-md border">
          <p className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
            <MessageSquare className="h-3 w-3" /> Initial Message
          </p>
          <p className="text-sm text-foreground">{lead.initial_message}</p>
        </div>
      )}

      {lead.next_step && (
        <p className="text-sm text-foreground">
          <span className="font-medium">Next step:</span> {lead.next_step}
        </p>
      )}
    </div>
  );
}
